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

    var LockManager = function(lockStatus) {
        this.$lockStatus = $(lockStatus);
        this.config = DJANGO_LOCKING.config || {};
        this.urls = this.config.urls || {};
        // Grab the object's ID from its url.
        // If it's 0, we're in the list view. If it's undefined, we're in the add view.
        this.objId = this.urls.lock_remove === undefined ? '0' : this.urls.lock_remove.split('/')[4];
        if (this.objId === '0') {
            this.$lockStatus.hide();
        }

        for (var key in this.text) {
            if (typeof gettext == 'function') {
                this.text[key] = gettext(this.text[key]);
            }
        }

        this.bindLockOnCloseEvents();

        var self = this;
        $(document).on('click', 'a.locking-status', function(e) {
            return self.removeLockOnClick(e);
        });

        $(document).on('click', 'a', function(evt) {
            return self.onLinkClick(evt);
        });

        $('a').bindFirst('click', function(evt) {
            self.onLinkClick(evt);
        });

        // Default to locking the page
        if (this.objId != '0') {
            this.updateStatus('Locked by you', this.text.is_locked_by_you, '')
        }
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
                'arrow-down-handler', 'grp-arrow-down-handler',
                'vDateField-link', 'vTimeField-link',
                'related-lookup'
            ]);
            if (isHandler) {
                e.stopPropagation();
                e.preventDefault();
                alert("Page is locked");
                e.returnValue = false;
                return false;
            }
        },
        modalButtonsExist: function(parentDoc) {
          var els = parentDoc.querySelectorAll('.cms-modal-buttons .cms-btn');
          return els.length > 0;
        },
        bindLockOnCloseEvents: function() {
          var boundLockOnClose = this.lockOnClose.bind(this);
          var parentDoc = window.parent.document;
          var cancelButtonSelector = '.cms-modal-buttons .cms-modal-item-buttons:last-of-type .cms-btn';

          var buttonPollInterval = setInterval(function() {
            if (this.modalButtonsExist(parentDoc)) {
              clearInterval(buttonPollInterval);

              var cancelButton = parentDoc.querySelector(cancelButtonSelector);
              var closeButton = parentDoc.querySelector('.cms-modal-close');

              cancelButton.addEventListener('mouseup', function(e) {
                boundLockOnClose();
              });

              closeButton.addEventListener('mouseup', function() {
                boundLockOnClose();
              });
            }
          }.bind(this), 250);

          $(window).on('beforeunload', function() {
            boundLockOnClose();
          });
        },
        lockOnClose: function() {
          // We have to assure that our lock_clear request actually
          // gets through before the user leaves the page, so it
          // shouldn't run asynchronously.
          if (!this.urls.lock_clear) {
              return;
          }
          if (!this.lockingSupport) {
              return;
          }

          $.ajax({
              url: this.urls.lock_clear,
              async: false,
              cache: false
          });
        },
        toggleEditorReadonly: function(isReadOnly) {
            // Check for CKEditor, then tinyMCE, then CodeMirror
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
            // now check for CodeMirror
            if (window.CodeMirror !== undefined) {
                $.each($('.CodeMirror'), function() {
                    var editor = this.CodeMirror;
                    if (editor !== undefined) {
                        editor.doc.cm.options['readOnly'] = isReadOnly;
                    }
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
            var locked_by_user = 'Locked by ' + data['locked_by_name']
            if (data.isReadonly) {
                this.isReadonly = true;
                this.updateStatus('Read-only', this.text.is_readonly, data);
            } else if (this.lockOwner && this.lockOwner == (this.currentUser || data.current_user)) {
                var msg;
                if (data.locked_by) {
                    msg = data.locked_by + " removed your lock.";
                    this.updateStatus(locked_by_user, this.text.lock_removed, data);
                } else {
                    msg = "You lost your lock.";
                    this.updateStatus(locked_by_user, this.text.has_expired, data);
                }
                alert(msg);
            } else {
                this.updateStatus(locked_by_user, this.text.is_locked, data);
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
            lock_removed: 'User "%(locked_by_name)s" removed your lock. If you save, ' +
                         'you or %(locked_by_name)s may lose data. Beware! Coordinate!',
            is_locked:   'This page is locked by %(locked_by_name)s ' +
                         'and editing is disabled. To force it to unlock, click here.',
            has_expired: 'You have lost your lock on this page. If you save, ' +
                         'you or another writer may lose data. Beware!',
            is_readonly: 'This page is in read-only mode. ' +
                         'You cannot make any changes. To switch to edit mode, ' +
                         'click here to refresh the page.',
            is_locked_by_you: 'You have opened this page in edit mode. ' +
                         'Only you can make changes. To allow others to edit, ' +
                         'click here to enable read-only mode.'
        },
        lockOwner: null,
        currentUser: null,
        refreshTimeout: null,
        lockingSupport: true,  // false for changelist views and new objects
        isReadonly: false,
        refreshLock: function() {
            if (this.isReadonly || !this.urls.lock) {
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
        updateStatus: function(message, text, data) {
            var self = this;

            $('html, body').scrollTop(0);
            text = interpolate(text, data, true);
            var $elem = this.$lockStatus
            $elem.off('click').hide()
            switch (message) {
                case 'Locked by you':
                    $elem.on('click', function(e) {self.enableReadonlyOnClick(e)});
                    break;
                case 'Read-only':
                    $elem.on('click', function(e) {self.reloadPage($elem)});
                    break;
                default:
                    $elem.on('click', function(e) {self.removeLockOnClick(e)})
                    break;
            }
            $elem.attr('title', text)
                 .attr('class', 'default')
                 .html('&#128274; ' + message)
                 .wrap('<li></li>')
                 .fadeIn('slow');
        },
        reloadPage: function(elem) {
            $(elem).html('&#128274; Reloading...');
            window.location.reload(true)
        },
        enableReadonlyOnClick: function(e) {
            e.preventDefault();
            var self = this;
            $.ajax({
                url: this.urls.lock_clear,
                async: false,
                success: function() {
                    var data = {'isReadonly': true};
                    self.disableForm(data);
                }
            });
        },
        // Locking toggle function
        removeLockOnClick: function(e) {
            var self = this;
            e.preventDefault();
            var $link = $(e.target);
            if (self.objId === '0') {
                // it's coming from the list view
                if (!$link.hasClass('locking-locked')) {
                    return;
                }
                var user = $link.attr('data-locked-by');
                var lockedObjId = $link.attr('data-locked-obj-id');
            } else {
                // grab the username from the button text
                var user = $link.text().substr(11);
                var lockedObjId = self.objId;
            }
            var removeLockUrl = this.getUrl("lock_remove", lockedObjId);
            if (removeLockUrl) {
                if (confirm("User '" + user + "' currently has a lock on this " +
                            "content. Do you want to force it to unlock?")) {
                    $.ajax({
                        url: removeLockUrl,
                        async: false,
                        success: function() {
                            if (self.objId === '0') {
                                $link.hide();
                            } else {
                                self.reloadPage($link)
                            }
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
        var $target = $('#content');
        var $lockingTag = $('<a class="btn" href="#">&#128274; Locking</a>');

        $target.css('list-style', 'none');
        $lockingTag.css({
          background: '#539bae',
          color: '#FFF',
          display: 'block',
          'margin-bottom': '20px',
          'max-width': '130px',
          padding: '10px',
          'text-align': 'center'
        });

        $lockingTag.prependTo($target).djangoLocking();
    });

})((typeof grp == 'object' && grp.jQuery)
        ? grp.jQuery
        : (typeof django == 'object' && django.jQuery) ? django.jQuery : jQuery);
