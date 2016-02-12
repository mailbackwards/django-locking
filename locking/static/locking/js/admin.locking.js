/*
Client side handling of locking for the ModelAdmin change page.

Only works on change-form pages, not for inline edits in the list view.
*/

// Set the namespace.
var DJANGO_LOCKING = DJANGO_LOCKING || {};

// Make sure jQuery is available.
(function($) {

    if (typeof $.fn.hasClasses === 'undefined') {
        var re_classNameWhitespace = /[\n\t\r ]+/g;

        $.fn.hasClasses = function(classes) {
            if (!classes || typeof(classes) != 'object' || !classes.length) {
                return false;
            }
            var i,
                l = this.length,
                classNameRegex = new RegExp("( " + classes.join(" | ") + " )");
            for (i = 0; i < l; i++) {
                if (this[i].nodeType !== 1) {
                    continue;
                }
                var testStr = (" " + this[i].className + " ").replace(re_classNameWhitespace, " ");
                if (classNameRegex.test(testStr)) {
                    return true;
                }
            }
            return false;
        };
    }

    if (typeof $.fn.bindFirst === 'undefined') {
        $.fn.bindFirst = function(name, fn) {
            // bind as you normally would
            // don't want to miss out on any jQuery magic
            this.on(name, fn);

            // Thanks to a comment by @Martin, adding support for
            // namespaced events too.
            this.each(function() {
                var handlers = $._data(this, 'events')[name.split('.')[0]];
                // take out the handler we just inserted from the end
                var handler = handlers.pop();
                // move it at the beginning
                handlers.splice(0, 0, handler);
            });
        };
    }

    // We're currently not doing anything here...
    DJANGO_LOCKING.error = function() {
        return;
    };

    var LockManager = function(notificationElement) {
        this.$notificationElement = $(notificationElement);
        this.config = DJANGO_LOCKING.config || {};
        this.urls = this.config.urls || {};

        for (var key in this.text) {
            if (typeof gettext == 'function') {
                this.text[key] = gettext(this.text[key]);
            }
        }

        var self = this;
        $(document).on('click', 'a.locking-status', function(e) {
            return self.removeLockOnClick(e);
        });

        // Disable lock when you leave
        $(window).on('beforeunload', function() {

            // We have to assure that our lock_clear request actually
            // gets through before the user leaves the page, so it
            // shouldn't run asynchronously.
            if (!self.urls.lock_clear) {
                return;
            }
            if (!self.lockingSupport) {
                return;
            }

            $.ajax({
                url: self.urls.lock_clear,
                async: false,
                cache: false
            });

        });
        $(document).on('click', 'a', function(evt) {
            return self.onLinkClick(evt);
        });
        $('a').bindFirst('click', function(evt) {
            self.onLinkClick(evt);
        });

        this.refreshLock();
    };

    $.extend(LockManager.prototype, {
        isDisabled: false,
        onLinkClick: function(e) {
            var self = this;
            $a = $(e.target);
            if (!self.isDisabled) {
                return true;
            }

            var isHandler = $a.hasClasses([
                'grp-add-handler', 'add-handler',
                'add-another',
                'grp-delete-handler', 'delete-handler',
                'delete-link',
                'remove-handler', 'grp-remove-handler',
                'arrow-up-handler', 'grp-arrow-up-handler',
                'arrow-down-handler', 'grp-arrow-down-handler'
            ]);
            if (isHandler) {
                e.stopPropagation();
                e.preventDefault();
                alert("Page is locked");
                e.returnValue = false;
                return false;
            }
        },
        toggleEditorReadonly: function(isReadOnly) {
            // Check for CKEditor, then tinyMCE
            if (window.CKEDITOR !== undefined) {
                var toggleCKEditor = function(editor) {
                    if (editor.status == 'ready' || editor.status == 'basic_ready') {
                        editor.setReadOnly(isReadOnly);
                    } else {
                        editor.on('contentDom', function(e) {
                            e.editor.setReadOnly(isReadOnly);
                        });
                    }
                };
                switch (CKEDITOR.status) {
                    case 'basic_ready':
                    case 'ready':
                    case 'loaded':
                    case 'basic_loaded':
                        for (var instanceId in CKEDITOR.instances) {
                            toggleCKEditor(CKEDITOR.instances[instanceId]);
                        }
                        break;
                    default:
                        CKEDITOR.on("instanceReady", function(e) {
                            toggleCKEditor(e.editor);
                        });
                        break;
                }
            }
            if (window.tinyMCE !== undefined) {
                // Disable contentEditable for current editors
                $.each(tinyMCE.editors, function() {
                    var contentEditable = (!isReadOnly).toString();
                    if (this.getBody !== undefined) {
                        this.getBody().setAttribute('contenteditable', contentEditable);
                    }
                });
                // Make sure future editors are set to readonly
                tinyMCE.onAddEditor.add(function(mgr, editor) {
                    editor.settings.readonly = isReadOnly;
                });
            }
        },
        enableForm: function() {
            if (!this.isDisabled) {
                return;
            }
            this.isDisabled = false;
            $(":input:not(.django-select2, .django-ckeditor-textarea)").not('._locking_initially_disabled').removeAttr("disabled");
            $("body").removeClass("is-locked");

            this.toggleEditorReadonly(false);

            if (typeof $.fn.select2 === "function") {
                $('.django-select2').select2("enable", true);
            }
            $(document).trigger('locking:enabled');
        },
        disableForm: function(data) {
            if (this.isDisabled) {
                return;
            }
            this.isDisabled = true;
            this.lockingSupport = false;
            data = data || {};
            if (this.lockOwner && this.lockOwner == (this.currentUser || data.current_user)) {
                var msg;
                if (data.locked_by) {
                    msg = data.locked_by + " removed your lock.";
                    this.updateNotification(this.text.lock_removed, data);
                } else {
                    msg = "You lost your lock.";
                    this.updateNotification(this.text.has_expired, data);
                }
                alert(msg);
            } else {
                this.updateNotification(this.text.is_locked, data);
            }
            $(":input[disabled]").addClass('_locking_initially_disabled');
            $(":input:not(.django-select2, .django-ckeditor-textarea)").attr("disabled", "disabled");
            $("body").addClass("is-locked");

            this.toggleEditorReadonly(true);

            if (typeof $.fn.select2 === "function") {
                $('.django-select2').select2("enable", false);
            }
            $(document).trigger('locking:disabled');
        },
        text: {
            warn:        'Your lock on this page expires in less than %s ' +
                         'minutes. Press save or <a href="">reload the page</a>.',
            lock_removed: 'User "%(locked_by_name)s" removed your lock. If you save, ' +
                         'your attempts may be thwarted due to another lock ' +
                         ' or you may have stale data.',
            is_locked:   'This page is locked by <em>%(locked_by_name)s</em> ' +
                         'and editing is disabled.',
            has_expired: 'You have lost your lock on this page. If you save, ' +
                         'your attempts may be thwarted due to another lock ' +
                         ' or you may have stale data.',
            prompt_save: 'Do you wish to save the page?'
        },
        lockOwner: null,
        currentUser: null,
        refreshTimeout: null,
        lockingSupport: true,  // false for changelist views and new objects
        refreshLock: function() {
            if (!this.urls.lock) {
                return;
            }
            var self = this;

            $.ajax({
                url: self.urls.lock,
                cache: false,
                success: function(data, textStatus, jqXHR) {
                    // The server gave us locking info. Either lock or keep it
                    // unlocked while showing notification.
                    if (!self.currentUser) {
                        self.currentUser = data.current_user;
                    }
                    if (!data.applies) {
                        self.enableForm();
                    } else {
                        self.disableForm(data);
                    }
                    self.lockOwner = data.locked_by;
                },
                error: function(jqXHR, textStatus, errorThrown) {
                    try {
                        data = $.parseJSON(jqXHR.responseText) || {};
                    } catch(e) {
                        data = {};
                    }
                    if (!self.currentUser) {
                        self.currentUser = data.current_user;
                    }
                    if (jqXHR.status === 404) {
                        self.lockingSupport = false;
                        self.enableForm();
                        return;
                    } else if (jqXHR.status === 423) {
                        self.disableForm(data);
                    } else {
                        DJANGO_LOCKING.error();
                    }
                    self.lockOwner = data.locked_by;
                },
                complete: function() {
                    if (self.refreshTimeout) {
                        clearTimeout(self.refreshTimeout);
                        self.refreshTimeout = null;
                    }
                    if (!self.lockingSupport) {
                        return;
                    }
                    self.refreshTimeout = setTimeout(function() { self.refreshLock(); }, 30000);
                }
            });
        },
        getUrl: function(action, id) {
            var baseUrl = this.urls[action];
            if (typeof baseUrl == 'undefined') {
                return null;
            }
            var regex = new RegExp("\/0\/" + action + "\/$");
            return baseUrl.replace(regex, "/" + id + "/" + action + "/");
        },
        updateNotification: function(text, data) {
            $('html, body').scrollTop(0);
            text = interpolate(text, data, true);
            this.$notificationElement.html(text).hide().fadeIn('slow');
        },
        // Locking toggle function
        removeLockOnClick: function(e) {
            e.preventDefault();
            var $link = $(e.target);
            if (!$link.hasClass('locking-locked')) {
                return;
            }
            var user = $link.attr('data-locked-by');
            var lockedObjId = $link.attr('data-locked-obj-id');
            var removeLockUrl = this.getUrl("lock_remove", lockedObjId);
            if (removeLockUrl) {
                if (confirm("User '" + user + "' is currently editing this " +
                            "content. Proceed with lock removal?")) {
                    $.ajax({
                        url: removeLockUrl,
                        async: false,
                        success: function() {
                            $link.hide();
                        }
                    });
                }
            }
        }
    });
    $.fn.djangoLocking = function() {
        // Only use the first element in the jQuery list
        var $this = this.eq(0);
        var lockManager = $this.data('djangoLocking');
        if (!lockManager) {
            lockManager = new LockManager($this);
        }
        return lockManager;
    };

    $(document).ready(function() {
        var $target = $("#content-inner, #content").eq(0);
        var $notificationElement = $('<div id="locking_notification"></div>').prependTo($target);
        $notificationElement.djangoLocking();
    });

})((typeof grp == 'object' && grp.jQuery)
        ? grp.jQuery
        : (typeof django == 'object' && django.jQuery) ? django.jQuery : jQuery);
