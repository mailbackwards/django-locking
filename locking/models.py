import logging
from datetime import datetime

from django.db import models

# Forward compat with Django 1.5's custom user models
from django.conf import settings
try:
    from django.contrib.auth import get_user_model
except ImportError:
    from amc_ldap.utils import get_user_model

from django.contrib.contenttypes.models import ContentType
try:
    from django.contrib.contenttypes.fields import GenericRelation, GenericForeignKey
except ImportError:
    from django.contrib.contenttypes.generic import GenericRelation, GenericForeignKey

from . import managers, settings as locking_settings
from .utils import timedelta_to_seconds


logger = logging.getLogger('django.locker')


class ObjectLockedError(IOError):
    pass


class LockingManager(models.Manager):

    def get_lock_for_object(self, obj, filters=None):
        if not isinstance(obj, models.Model):
            raise TypeError((
                "%(fn)s() argument 1 must be %(expected_type)s, not "
                "%(actual_type)s") % {
                    'fn': 'get_lock_for_object',
                    'expected_type': "django.db.models.Model",
                    'actual_type': type(obj).__name__,})
        if not getattr(obj._meta, 'pk', None):
            raise Exception((
                u"Cannot get lock for instance %(instance)s; model "
                u"%(app_label)s.%(object_name)s has no primary key field") % {
                    'instance': unicode(obj),
                    'app_label': obj._meta.app_label,
                    'object_name': obj._meta.object_name,})

        if filters is None:
            # Check if the models define a GenericRelation to locking.Lock,
            # and if so use that. This allows the use of prefetch_related()
            # for locks in changelist views.
            generic_rels = [f for f in obj._meta.many_to_many
                            if isinstance(f, GenericRelation)]
            try:
                locks_field = [f.name for f in generic_rels if f.rel.to == self.model][0]
            except IndexError:
                pass
            else:
                locks = getattr(obj, locks_field).all()
                try:
                    return locks[0]
                except IndexError:
                    raise self.model.DoesNotExist("Lock matching query does not exist.")

        filter_kwargs = {
            'content_type': ContentType.objects.get_for_model(obj.__class__),
            'object_id': obj.pk,
        }
        if filters:
            filter_kwargs.update(filters)
        return self.get(**filter_kwargs)


class Lock(models.Model):
    """
    LockableModel comes with three managers: ``objects``, ``locked`` and
    ``unlocked``. They do what you'd expect them to.
    """

    def __init__(self, *vargs, **kwargs):
        super(Lock, self).__init__(*vargs, **kwargs)
        self._state.locking = False

    objects = LockingManager()

    locked = managers.LockedManager()

    unlocked = managers.UnlockedManager()

    content_type = models.ForeignKey(ContentType, on_delete=models.CASCADE)
    object_id = models.PositiveIntegerField()

    content_object = GenericForeignKey('content_type', 'object_id')

    _locked_at = models.DateTimeField(db_column='locked_at',
        null=True,
        editable=False)

    _locked_by = models.ForeignKey(settings.AUTH_USER_MODEL,
        db_column='locked_by',
        related_name="working_on_%(app_label)s_%(class)s",
        null=True,
        editable=False,
        on_delete=models.CASCADE)

    _hard_lock = models.BooleanField(db_column='hard_lock', default=False,
                                     editable=False)

    class Meta:
        ordering = ('-_locked_at',)

    # We don't want end-developers to manipulate database fields directly,
    # hence we're putting these behind simple getters.
    # End-developers should use functionality like the lock_for method instead.
    @property
    def locked_at(self):
        """A simple ``DateTimeField`` that is the heart of the locking
        mechanism. Read-only."""
        return self._locked_at

    @property
    def locked_by(self):
        """``locked_by`` is a foreign key to ``auth.User``.
        The ``related_name`` on the User object is ``working_on_%(app_label)s_%(class)s``.
        Read-only."""
        return self._locked_by

    @property
    def lock_type(self):
        """ Returns the type of lock that is currently active. Either
        ``hard``, ``soft`` or ``None``. Read-only. """
        if self.is_locked:
            if self._hard_lock:
                return "hard"
            else:
                return "soft"
        else:
            return None

    @property
    def is_locked(self):
        """
        A read-only property that returns True or False.
        Works by calculating if the last lock (self.locked_at) has timed out
        or not.
        """
        if not isinstance(self.locked_at, datetime):
            return False
        return datetime.now() < self.lock_expiration_time


    @property
    def lock_expiration_time(self):
        """
        The time when the lock will have expired, as a datetime object
        """
        if not isinstance(self.locked_at, datetime):
            return None
        return self.locked_at + locking_settings.TIME_UNTIL_EXPIRATION

    @property
    def lock_seconds_remaining(self):
        """
        A read-only property that returns the amount of seconds remaining
        before any existing lock times out.

        May or may not return a negative number if the object is currently
        unlocked. That number represents the amount of seconds since the last
        lock expired.

        If you want to extend a lock beyond its current expiry date, initiate
        a new lock using the ``lock_for`` method.
        """
        if not self.locked_at:
            return 0
        locked_delta = datetime.now() - self.locked_at
        # If the lock has already expired, there are 0 seconds remaining
        if locking_settings.TIME_UNTIL_EXPIRATION < locked_delta:
            return 0
        until = locking_settings.TIME_UNTIL_EXPIRATION - locked_delta
        return timedelta_to_seconds(until)

    def lock_for(self, user, hard_lock=True, lock_duration=None, override=False):
        """
        Together with ``unlock_for`` this is probably the most important
        method on this model. If applicable to your use-case, you should lock
        for a specific user; that way, we can throw an exception when another
        user tries to unlock an object they haven't locked themselves.

        When using soft locks, any process can still use the save method
        on this object. If you set ``hard_lock=True``, trying to save an object
        without first unlocking will raise an ``ObjectLockedError``.

        Don't use hard locks unless you really need them. See :doc:`design`.

        The 'hard lock' flag is set to True as the default as a fail safe
        method to back up javascript lock validations.  This is useful when
        the user's lock expires or javascript fails to load, etc.
        Keep in mind that soft locks are set since they provide the user with
        a user friendly locking interface.
        """
        logger.debug("Attempting to initiate a lock for user `%s`" % user)

        UserModel = get_user_model()

        if not isinstance(user, UserModel):
            raise ValueError("You should pass a valid auth.User to lock_for.")

        if self.lock_applies_to(user):
            if override:
                lock_duration = locking_settings.LOCK_CLEAR_TIMEOUT
            else:
                raise ObjectLockedError("This object is already locked by another"
                    " user. May not override, except through the `unlock` method.")
        locked_at = datetime.now()
        if lock_duration:
            locked_at += lock_duration - locking_settings.TIME_UNTIL_EXPIRATION
        self._locked_at = locked_at
        self._locked_by = user
        self._hard_lock = self.__init_hard_lock = hard_lock
        # an administrative toggle, to make it easier for devs to extend `django-locking`
        # and react to locking and unlocking
        self._state.locking = True
        logger.debug(
            "Initiated a %s lock for `%s` at %s" % (
            self.lock_type, self.locked_by, self.locked_at
            ))

    def unlock(self):
        """
        This method serves solely to allow the application itself or admin
        users to do manual lock overrides, even if they haven't initiated
        these locks themselves. Otherwise, use ``unlock_for``.
        """
        self._locked_at = self._locked_by = None
        # an administrative toggle, to make it easier for devs to extend `django-locking`
        # and react to locking and unlocking
        self._state.locking = True
        logger.debug("Disengaged lock on `%s`" % self)

    def unlock_for(self, user, override=False):
        """
        See ``lock_for``. If the lock was initiated for a specific user,
        unlocking will fail unless that same user requested the unlocking.
        Manual overrides should use the ``unlock`` method instead.

        Will raise a ObjectLockedError exception when the current user isn't
        authorized to unlock the object.
        """
        logger.debug("Attempting to open up a lock on `%s` by user `%s`" % (
                                                                  self, user))
        if override:
            self.lock_for(user, override=override)
        else:
            if not self.lock_applies_to(user):
                self.unlock()
                self.save()

    def lock_applies_to(self, user):
        """
        A lock does not apply to the user who initiated the lock. Thus,
        ``lock_applies_to`` is used to ascertain whether a user is allowed
        to edit a locked object.
        """
        logger.debug("Checking if the lock on `%s` applies to user `%s`" % (
                                                                  self, user))
        # a lock does not apply to the person who initiated the lock
        user_pk = getattr(user, 'pk', None)
        locked_user_pk = self._locked_by_id
        if self.is_locked and locked_user_pk != user_pk:
            logger.debug("Lock applies.")
            return True
        else:
            logger.debug("Lock does not apply.")
            return False

    def is_locked_by(self, user):
        """
        Returns True or False. Can be used to test whether this object is
        locked by a certain user. The ``lock_applies_to`` method and the
        ``is_locked`` and ``locked_by`` attributes are probably more useful
        for most intents and
        purposes.
        """
        user_pk = getattr(user, 'pk', None)
        locked_user_pk = self._locked_by_id
        return bool(self.is_locked and user_pk and locked_user_pk == user_pk)

    def save(self, *vargs, **kwargs):
        super(Lock, self).save(*vargs, **kwargs)
        self._state.locking = False
