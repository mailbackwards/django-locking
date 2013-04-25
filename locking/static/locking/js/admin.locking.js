/*
Client side handling of locking for the ModelAdmin change page.

Only works on change-form pages, not for inline edits in the list view.
*/

// Set the namespace.
var locking = locking || {};

// Make sure jQuery is available.
(function(jQuery) {


// Begin wrap.
(function($, locking) {

// Global error function that redirects to the frontpage if something bad
// happens.
locking.error = function() {
    return;
    var text = ('An unexpected locking error occured. You will be' +
        ' forwarded to a safe place. Sorry!'
    );
    // Catch if gettext has not been included.
    try {
        alert(gettext(text));
    } catch(err) {
        alert(text);
    }
    window.location = '/';
};

    function unlock_click_event(base_url){
        //Locking toggle function
        $("a.lock-status").click(function(){
            console.log('this', $(this).attr('title'))
            user = $.trim($(this).text());
            id = $(this).attr('id');
            if ($(this).hasClass("locked")){
                if (confirm("User '" + user + "' is currently editing this " + 
                            "content. Proceed with removing the lock?")) {
                    $.ajax({'url': base_url + id + "/unlock/", 'async': false});
                    $(this).hide();
                    //$(this).toggleClass('unlocked');
                }
            }
            return false;
        });
    }

    // Handles locking on the contrib.admin edit page.
    locking.admin = function() {
        // Needs a try/catch here as well because exceptions does not propagate 
        // outside the onready call.
        settings = locking;
        // Get url parts.
        var adm_url = settings.admin_url;
        var pathname = window.location.pathname;
        if (pathname.indexOf(adm_url) == 0 && adm_url.length > 0) {
            var app = $.url.segment(1);
            var model = $.url.segment(2);
            var id = $.url.segment(3);
        } else {
            var app = $.url.segment(0);
            var model = $.url.segment(1);
            var id = $.url.segment(2);
        }
        var base_url = settings.base_url + "/" + [app, model, id].join("/");
        unlock_click_event(base_url);
        
        // Don't lock page if not on change-form page.
        if (!($("body").hasClass("change-form"))) return;

        var is_adding_content = function() {
            return (id === 'add' || // On a standard add page.
                    // On a add page handled by the ajax_select app.
                    $.url.segment(0) === 'ajax_select')
        };
        // Don't apply locking when adding content.
        if (is_adding_content()) return;
        
        
        // Urls.
        var base_url = settings.base_url + "/" + [app, model, id].join("/");
        var urls = {
            is_locked: base_url + "/is_locked/",
            lock: base_url + "/lock/",
            unlock: base_url + "/unlock/"
        };
                
        // Texts.
        var text = {
            warn: gettext('Your lock on this page expires in less than %s' +
                ' minutes. Press save or <a href=".">reload the page</a>.'),
            is_locked: gettext('This page is locked by <em>%(for_user)s' + 
                '</em> and editing is disabled.'),
            has_expired: gettext('Your lock on this page is expired!' + 
                ' If you save now, your attempts may be thwarted due to another lock,' +
                ' or even worse, you may have stale data.'
            ),
            prompt_to_save: 'Do you wish to save the page?',
        };
        
        // Creates empty div in top of page.
        var create_notification_area = function() {
            $("#content-main,#content-inner").prepend(
                '<div id="locking_notification"></div>');
        };
        
        // Scrolls to the top, updates content of notification area and fades
        // it in.
        var update_notification_area = function(content, func) {
            $('html, body').scrollTop(0);
            $("#locking_notification").html(content).hide()
                                      .fadeIn('slow', func);
        };
        
        // Displays a warning that the page is about to expire.
        var display_warning = function() {
            var promt_to_save = function() {
                if (confirm(text.prompt_to_save)) {
                    $('form input[type=submit][name=_continue]').click();
                }
            }
            var minutes = Math.round((settings.time_until_expiration - 
                settings.time_until_warning) / 60);
            if (minutes < 1) minutes = 1;
            update_notification_area(interpolate(text.warn, [minutes]), 
                                     promt_to_save);
        };
        
        // Displays notice on top of page that the page is locked by someone 
        // else.
        var display_islocked = function(data) {
            update_notification_area(interpolate(text.is_locked, data, true));
        };
        
        // Disables all form elements.
        var disable_form = function() {
            $(":input[disabled]").addClass('_locking_initially_disabled');
            $(":input").attr("disabled", "disabled");

            // Grapelli's delete is an anchor tag :(
            $('a.delete-link').each(function() {
                // Copy over the old_href
                $(this).attr('old_href', $(this).attr('href'));
                $(this).attr('href', 'javascript:alert("Page is locked.");');
            });

            // Handle CKeditors as well, which is a little annoying since there
            // is an inherent race condition with it.
            if(window.CKEDITOR !== undefined) {
                CKEDITOR.on("instanceReady", function(e) {
                    e.editor.setReadOnly(true);
                });
            }
        };
        
        // Enables all form elements that was not disabled from the start.
        var enable_form = function() {
            $(":input").not('._locking_initially_disabled').removeAttr("disabled");
            $('a.delete-link').each(function() {
                $(this).attr('href', $(this).attr('old_href'));
            });
            // Handle CKeditors as well
            if(window.CKEDITOR !== undefined) {
                CKEDITOR.on("instanceReady", function(e) {
                    e.editor.setReadOnly(false);
                });
            }

            // Handle django-select2.  We really should add events to
            // django-locking so other items can know when to enable/disable
            if($.fn.select2 !== undefined) {
                $('.django-select2').each(function() {
                    $(this).select2("enable");
                });
            }

        };
        
        // The user did not save in time, expire the page.
        var expire_page = function() {
            update_notification_area(text.has_expired);
        };


        var lock_renewer; // This needs to live in higher state so other functions can clear it.
        var setup_locked_page = function(){

            // Keep locked
            lock_renewer = setInterval(refresh_lock, 30000);
            
            // Disable lock when you leave
            $(window).unload(function() {
                // We have to assure that our unlock request actually 
                // gets through before the user leaves the page, so it 
                // shouldn't run asynchronously.
                $.ajax({
                    url: urls.unlock,
                    async: false,
                    cache: false
                });
            });

        };
        
        // Request a lock on the page, and unlocks page when the user leaves.
        // Adds delayed execution of user notifications.
        var lock_page = function() {
            $.ajax({
                url: urls.lock,
                cache: false,
                complete: function(jqXHR, textStatus) {
                    if (jqXHR.status === 403) {
                        display_islocked();
                    } else if (jqXHR.status === 200) {
                        enable_form();
                        setup_locked_page();
                    } else {
                        locking.error();
                    }
                }
            });
        };

        var refresh_lock = function(){
            $.getJSON(urls.is_locked, function(resp){
                if (resp.for_user === DJANGO_GLOBALS.username) {
                    $.get(urls.lock);
                    console.log('Rewened');
                } else {
                    var msg; // If possible, we should let the user know who's competing for the lock.
                    if(resp.for_user || false) {
                        msg = resp.for_user + " removed your lock on this story.";
                    } else {
                        msg = "You lost your lock on this story. Save your work."
                    }
                    alert(msg); // This should be obnoxious and grab focus.
                    expire_page();
                    clearInterval(lock_renewer); // Stop making calls, we're done.
                }
            });
        };
        
        // The server gave us locking info. Either lock or keep it unlocked
        // while showing notification.
        var parse_succesful_request = function(data, textStatus, jqXHR) {
            if (!data.applies) {
                lock_page();
            } else {
                display_islocked(data);
            }
        };
        
        // Polls server for the page lock status.
        var request_locking_info = function() {
            $.ajax({
                url: urls.is_locked,
                success: parse_succesful_request,
                error: locking.error,
                cache: false
            });
        };
        
        // Initialize.
        disable_form();
        create_notification_area();
        request_locking_info();

    };

    // Catches any error and redirects to a safe place if any.
    try {
        $(locking.admin);
    } catch(err) {
        locking.error();
    }

// End wrap.
})(jQuery, locking);
})((typeof window.django != 'undefined') ? django.jQuery : jQuery);

