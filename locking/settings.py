from django.conf import settings


LOCKING_ENABLED = getattr(settings, 'LOCKING_ENABLED', True)
LOCKING_URL = getattr(settings, 'LOCKING_URL', '/locking/')
STATIC_URL = getattr(settings, 'STATIC_URL', '/static/')


def get_timedelta_setting(key, default=None):
    # Importing inside function to keep exports cleaner
    import collections
    from datetime import timedelta
    from django.core.exceptions import ImproperlyConfigured

    LOCKING_SETTINGS = getattr(settings, 'LOCKING', {})

    value = LOCKING_SETTINGS.get(key, default)
    try:
        if isinstance(value, timedelta):
            pass
        elif isinstance(value, collections.Mapping):
            value = timedelta(**value)
        else:
            value = timedelta(seconds=value)
    except TypeError:
        raise ImproperlyConfigured((
            "LOCKING_SETTINGS['%(key)s'] must be either a datetime.timedelta "
            "object, a dict of kwargs pass to datetime.timedelta, or a "
            "number of seconds (int); instead got %(type)s" % {
                'key': key,
                'type': type(value).__name__,
            }))

    return value


TIME_UNTIL_EXPIRATION = get_timedelta_setting('time_until_expiration', 600)
TIME_UNTIL_WARNING = get_timedelta_setting('time_until_warning', 540)
# The time it takes for a lock created when a user clears another lock,
# before the object returns to an unlocked state.
LOCK_CLEAR_TIMEOUT = get_timedelta_setting('lock_clear_timeout', 30)
LOCK_TIMEOUT = getattr(settings, 'LOCK_TIMEOUT', 1800)
