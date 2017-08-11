"""
These views are called from javascript to open and close assets (objects), in order
to prevent concurrent editing.
"""
import json
import textwrap

from django.core.exceptions import ObjectDoesNotExist
from django.core.urlresolvers import reverse
from django.http import HttpResponse
from django.contrib.contenttypes.models import ContentType

from .utils import timedelta_to_seconds
from .models import Lock, ObjectLockedError
from . import settings as locking_settings


json_encode = json.JSONEncoder(indent=4).encode


def lock(model_admin, request, object_id, extra_context=None):
    existing_lock_pk = request.GET.get('lock_pk')
    ct = ContentType.objects.get_for_model(model_admin.model)
    try:
        lock = Lock.objects.get(content_type=ct, object_id=object_id)
    except Lock.DoesNotExist:
        try:
            ct.get_object_for_this_type(pk=object_id)
        except ObjectDoesNotExist:
            lock = None
        else:
            if not existing_lock_pk:
                lock = Lock(content_type=ct, object_id=object_id)

    if lock is None:
        if existing_lock_pk:
            status = 403
        else:
            status = 404
    else:
        try:
            lock.lock_for(request.user)
        except ObjectLockedError:
            status = 423 # HTTP 423 = 'Locked'
        else:
            status = 200
            lock.save()
    return render_lock_status(request, lock=lock, status=status)


def _unlock(model_admin, request, object_id, extra_context=None, filter_user=False):
    ct = ContentType.objects.get_for_model(model_admin.model)
    filter_kwargs = {}
    if filter_user:
        filter_kwargs['_locked_by'] = request.user
        override = False
    else:
        override = True
    try:
        lock = Lock.objects.get(content_type=ct, object_id=object_id, **filter_kwargs)
    except Lock.DoesNotExist:
        return HttpResponse(status=404)
    else:
        try:
            lock.unlock_for(request.user, override=override)
        except ObjectLockedError:
            return HttpResponse(status=423)
        lock.save()
        return HttpResponse(status=200)


def lock_remove(model_admin, request, object_id, extra_context=None):
    """Remove any lock on object_id"""
    return _unlock(model_admin, request, object_id, extra_context=extra_context)


def lock_clear(model_admin, request, object_id, extra_context=None):
    """Clear any locks on object_id locked by the current user"""
    return _unlock(model_admin, request, object_id, extra_context=extra_context, filter_user=True)


def render_lock_status(request, lock=None, status=200):
    data = {
        'is_active': False,
        'applies': False,
        'for_user': None,
    }
    if lock:
        if not lock.locked_by:
            locked_by_name = None
        else:
            locked_by_name = lock.locked_by.get_full_name()
            if locked_by_name:
                locked_by_name = u"%(username)s (%(fullname)s)" % {
                    'username': lock.locked_by.username,
                    'fullname': locked_by_name,
                }
            else:
                locked_by_name = lock.locked_by.username
        data.update({
            'lock_pk': lock.pk,
            'current_user': getattr(request.user, 'username', None),
            'is_active': lock.is_locked,
            'locked_by': getattr(lock.locked_by, 'username', None),
            'locked_by_name': locked_by_name,
            'applies': lock.lock_applies_to(request.user),
        })
    return HttpResponse(json_encode(data), content_type='application/json', status=status)


def lock_status(model_admin, request, object_id, extra_context=None, **kwargs):
    ct = ContentType.objects.get_for_model(model_admin.model)
    try:
        lock = Lock.objects.get(content_type=ct, object_id=object_id)
    except Lock.DoesNotExist:
        lock = None
    return render_lock_status(request, lock, **kwargs)


def locking_js(model_admin, request, object_id, extra_context=None):
    opts = model_admin.model._meta
    info = (opts.app_label, opts.object_name.lower())
    kwargs = {
        'args': [object_id],
        'current_app': model_admin.admin_site.name
    }

    locking_urls = {
        "lock_remove": reverse("admin:%s_%s_lock_remove" % info, **kwargs),
    }

    if object_id and object_id != '0':
        locking_urls.update({
            "lock": reverse("admin:%s_%s_lock" % info, **kwargs),
            "lock_clear": reverse("admin:%s_%s_lock_clear" % info, **kwargs),
            "lock_status": reverse("admin:%s_%s_lock_status" % info, **kwargs),
        })

    js_vars = {
        'urls': locking_urls,
        'time_until_expiration': timedelta_to_seconds(
                locking_settings.TIME_UNTIL_EXPIRATION),
        'time_until_warning': timedelta_to_seconds(
                locking_settings.TIME_UNTIL_WARNING),
    }

    response_js = textwrap.dedent("""
        var DJANGO_LOCKING = (typeof window.DJANGO_LOCKING != 'undefined')
                           ? DJANGO_LOCKING : {{}};
        DJANGO_LOCKING.config = {config_data}
    """).strip().format(config_data=json_encode(js_vars))
    return HttpResponse(response_js, content_type='application/x-javascript')
