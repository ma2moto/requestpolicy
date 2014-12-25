/*
 * ***** BEGIN LICENSE BLOCK *****
 *
 * RequestPolicy - A Firefox extension for control over cross-site requests.
 * Copyright (c) 2008-2012 Justin Samuel
 * Copyright (c) 2014 Martin Kimmerle
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 *
 * ***** END LICENSE BLOCK *****
 */


/**
 * Provides functionality for the overlay. An instance of this class exists for
 * each tab/window.
 */
requestpolicy.overlay = (function() {

  const Ci = Components.interfaces;
  const Cc = Components.classes;
  const Cu = Components.utils;

  Cu.import("resource://gre/modules/Services.jsm");

  let mod = {};
  Cu.import("chrome://requestpolicy/content/lib/script-loader.jsm", mod);
  mod.ScriptLoader.importModules([
    "constants",
    "logger",
    "prefs",
    "request-processor",
    "domain-util",
    "string-utils",
    "requestpolicy-service",
    "policy-manager"
  ], mod);
  let MMID = mod.MMID, Logger = mod.Logger, rpPrefBranch = mod.rpPrefBranch,
      Prefs = mod.Prefs, RequestProcessor = mod.RequestProcessor,
      DomainUtil = mod.DomainUtil, StringUtils = mod.StringUtils,
      rpService = mod.rpService, PolicyManager = mod.PolicyManager;

  //let _extensionConflictInfoUri = "http://www.requestpolicy.com/conflict?ext=";

  //let _prefetchInfoUri = "http://www.requestpolicy.com/help/prefetch.html";
  //let _prefetchDisablingInstructionsUri = "http://www.requestpolicy.com/help/prefetch.html#disable";


  let initialized = false;

  let toolbarButtonId = "requestpolicyToolbarButton";

  let overlayId = 0;

  let blockedContentStateUpdateDelay = 250; // milliseconds
  let blockedContentCheckTimeoutId = null;
  let blockedContentCheckMinWaitOnObservedBlockedRequest = 500;
  let blockedContentCheckLastTime = 0;

  let popupElement = null;

  //let statusbar = null;

  // TODO: get back entry in context menu
  // https://github.com/RequestPolicyContinued/requestpolicy/issues/353
  //let rpContextMenu = null;

  let toolbox = null;

  let isFennec = false;



  let self = {
    // This is set by request-log.js when it is initialized. We don't need to worry
    // about setting it here.
    requestLog: null
  };


  self.toString = function() {
    return "[requestpolicy.overlay " + overlayId + "]";
  };

  /**
   * Initialize the object. This must be done after the DOM is loaded.
   */
  self.init = function() {
    try {
      if (initialized == false) {
        initialized = true;
        overlayId = (new Date()).getTime();

        requestpolicy.menu.init();

        popupElement = document.getElementById("rp-popup");

        //statusbar = document.getElementById("status-bar");
        //rpContextMenu = document
        //    .getElementById("requestpolicyContextMenu");
        toolbox = document.getElementById("navigator-toolbox");

        var appInfo = Components.classes["@mozilla.org/xre/app-info;1"]
            .getService(Components.interfaces.nsIXULAppInfo);
        isFennec = (appInfo.ID == "{a23983c0-fd0e-11dc-95ff-0800200c9a66}");

        if (isFennec) {
          Logger.dump("Detected Fennec.");
          // Set an attribute for CSS usage.
          popupElement.setAttribute("fennec", "true");
          popupElement.setAttribute("position", "after_end");
        }

        // Register this window with the requestpolicy service so that we can be
        // notified of blocked requests. When blocked requests happen, this
        // object's observerBlockedRequests() method will be called.
        RequestProcessor.addRequestObserver(self);

        //self.setContextMenuEnabled(rpPrefBranch.getBoolPref("contextMenu"));
        self._setPermissiveNotification(Prefs.isBlockingDisabled());
      }
    } catch (e) {
      Logger.severe(Logger.TYPE_ERROR,
          "Fatal Error, " + e + ", stack was: " + e.stack);
      Logger.severe(Logger.TYPE_ERROR,
          "Unable to initialize requestpolicy.overlay.");
      throw e;
    }
  };

  //setContextMenuEnabled : function(isEnabled) {
  //  rpContextMenu.setAttribute("hidden", !isEnabled);
  //},

  self.onWindowUnload = function() {
    RequestProcessor.removeRequestObserver(self);
    self._removeHistoryObserver();
    self._removeLocationObserver();
  };

  /**
   * Perform the actions required once the window has loaded. This just sets a
   * listener for when the content of the window has changed (a page is loaded).
   *
   * @param {Event}
   *          event
   */
  self.onWindowLoad = function() {
    //try {
      // Info on detecting page load at:
      // http://developer.mozilla.org/En/Code_snippets/On_page_load
      var appcontent = document.getElementById("appcontent"); // browser
      const requestpolicyOverlay = this;
      if (appcontent) {
        if (isFennec) {
          appcontent.addEventListener("TabSelect", function(event) {
            requestpolicyOverlay.tabChanged();
          }, false);
        }
      }



      messageManager.addMessageListener(
          MMID + ":notifyDocumentLoaded",
          function(message) {
            dump("notifyDocumentLoaded\n\n");
            let {docID, documentURI} = message.data;

            // the <browser> element of the corresponding tab.
            let browser = message.target;

            if (rpPrefBranch.getBoolPref("indicateBlockedObjects")) {
              var indicateBlacklisted = rpPrefBranch
                  .getBoolPref("indicateBlacklistedObjects");

              var rejectedRequests = RequestProcessor._rejectedRequests
                  .getOriginUri(documentURI);
              let blockedURIs = {};
              for (var destBase in rejectedRequests) {
                for (var destIdent in rejectedRequests[destBase]) {
                  for (var destUri in rejectedRequests[destBase][destIdent]) {
                    // case 1: indicateBlacklisted == true
                    //         ==> indicate the object has been blocked
                    //
                    // case 2: indicateBlacklisted == false
                    // case 2a: all requests have been blocked because of a blacklist
                    //          ==> do *not* indicate
                    //
                    // case 2b: at least one of the blocked (identical) requests has been
                    //          blocked by a rule *other than* the blacklist
                    //          ==> *do* indicate
                    let requests = rejectedRequests[destBase][destIdent][destUri];
                    if (indicateBlacklisted ||
                        requestpolicyOverlay._containsNonBlacklistedRequests(
                            requests)) {
                      blockedURIs[destUri] = blockedURIs[destUri] ||
                          {identifier: DomainUtil.getIdentifier(destUri)};
                    }
                  }
                }
              }
              message.target.messageManager.sendAsyncMessage(
                  MMID + ":indicateBlockedVisibleObjects",
                  {blockedURIs: blockedURIs, docID: docID});
            }

            if ("requestpolicy" in browser &&
                documentURI in browser.requestpolicy.blockedRedirects) {
              var dest = browser.requestpolicy.blockedRedirects[documentURI];
              Logger.warning(Logger.TYPE_HEADER_REDIRECT,
                  "Showing notification for blocked redirect. To <" + dest +
                  "> " + "from <" + documentURI + ">");
              self._showRedirectNotification(browser, dest);

              delete browser.requestpolicy.blockedRedirects[documentURI];
            }
          });

      messageManager.addMessageListener(
          MMID + ":notifyTopLevelDocumentLoaded",
          function (message) {
            // Clear any notifications that may have been present.
            self._setContentBlockedState(false);
            // We don't do this immediately anymore because slow systems might have
            // this slow down the loading of the page, which is noticable
            // especially with CSS loading delays (it's not unlikely that slow
            // webservers have a hand in this, too).
            // Note that the change to _updateBlockedContentStateAfterTimeout seems to have
            // added a bug where opening a blank tab and then quickly switching back
            // to the original tab can cause the original tab's blocked content
            // notification to be cleared. A simple compensation was to decrease
            // the timeout from 1000ms to 250ms, making it much less likely the tab
            // switch can be done in time for a blank opened tab. This isn't a real
            // solution, though.
            self._updateBlockedContentStateAfterTimeout();
          });

      messageManager.addMessageListener(
          MMID + ":notifyDOMFrameContentLoaded",
          function (message) {
            // This has an advantage over just relying on the
            // observeBlockedRequest() call in that this will clear a blocked
            // content notification if there no longer blocked content. Another way
            // to solve this would be to observe allowed requests as well as blocked
            // requests.
            blockedContentCheckLastTime = (new Date()).getTime();
            self._stopBlockedContentCheckTimeout();
            self._updateBlockedContentState(message.target);
          });

      messageManager.addMessageListener(MMID + ":handleMetaRefreshes",
                                        self.handleMetaRefreshes);

      messageManager.addMessageListener(
          MMID + ":notifyLinkClicked", function (message) {
              RequestProcessor.registerLinkClicked(message.data.origin,
                                                   message.data.dest);
          });

      messageManager.addMessageListener(
          MMID + ":notifyFormSubmitted", function (message) {
              RequestProcessor.registerFormSubmitted(message.data.origin,
                                                     message.data.dest);
          });




      // Add an event listener for when the contentAreaContextMenu (generally
      // the right-click menu within the document) is shown.
      var contextMenu = document.getElementById("contentAreaContextMenu");
      if (contextMenu) {
        contextMenu.addEventListener("popupshowing",
            self._contextMenuOnPopupShowing, false);
      }

      // We consider the default place for the popup to be attached to the
      // context menu, so attach it there.
      //self._attachPopupToContextMenu();

      // Listen for the user changing tab so we can update any notification or
      // indication of blocked requests.
      if (!isFennec) {
        var container = gBrowser.tabContainer;
        container.addEventListener("TabSelect", function(event) {
          requestpolicyOverlay.tabChanged();
        }, false);
        self._wrapAddTab();
        self._addLocationObserver();
        self._addHistoryObserver();
      }

    //} catch (e) {
    //  Logger.severeError("Fatal Error, " + e, e);
    //  Logger.severeError(
    //      "Unable to complete requestpolicy.overlay.onWindowLoad actions.");
    //}
  };

  self.handleMetaRefreshes = function(message) {
    let {documentURI, metaRefreshes} = message.data;
    let browser = message.target;

    for (let i = 0, len = metaRefreshes.length; i < len; ++i) {
      let {delay, destURI, originalDestURI} = metaRefreshes[i];

      Logger.info(Logger.TYPE_META_REFRESH, "meta refresh to <" +
          destURI + "> (" + delay + " second delay) found in document at <" +
          documentURI + ">");

      if (originalDestURI) {
        Logger.info(Logger.TYPE_META_REFRESH,
            "meta refresh destination <" + originalDestURI + "> " +
            "appeared to be relative to <" + documentURI + ">, so " +
            "it has been resolved to <" + destURI + ">");
      }

      // We don't automatically perform any allowed redirects. Instead, we
      // just detect when they will be blocked and show a notification. If
      // the docShell has allowMetaRedirects disabled, it will be respected.
      if (!Prefs.isBlockingDisabled()
          && !RequestProcessor.isAllowedRedirect(documentURI, destURI)) {
        // Ignore redirects to javascript. The browser will ignore them, as well.
        if (DomainUtil.getUriObject(destURI).schemeIs("javascript")) {
          Logger.warning(Logger.TYPE_META_REFRESH,
              "Ignoring redirect to javascript URI <" + destURI + ">");
          continue;
        }
        // The request will be blocked by shouldLoad.
        self._showRedirectNotification(browser, destURI, delay);
      }
    }
  };

  /**
   * Shows a notification that an unknown scheme has been detected.
   * This notification in only necessary for 1.0 beta versions until custom
   * URI schemes are supported in RequestPolicy.
   *
   * issue: https://github.com/RequestPolicyContinued/requestpolicy/issues/447
   *
   * @param {nsIDOMWindow} contentWindow
   * @param {String} scheme
   */
  self.showSchemeNotification = function(contentWindow, scheme) {
    let browser = gBrowser.getBrowserForContentWindow(contentWindow);
    let notificationBox = gBrowser.getNotificationBox(browser)
    let notificationValue = "requestpolicy-scheme-notification";

    let notification = notificationBox
        .getNotificationWithValue(notificationValue);

    var notificationLabel = "This page contains a request with a '" + scheme +
        "' scheme which is unknown to RequestPolicy. Please report it.";

    if (notification) {
      notification.label = notificationLabel;
    } else {
      var buttons = [
        {
          label : "report this / more info",
          accessKey : "r",
          popup : null,
          callback : function() {
            let url = "https://github.com/RequestPolicyContinued/requestpolicy/issues/447";
            window.openUILinkIn(url, "tab", {relatedToCurrent: true});
          }
        },
        {
          label : "hide",
          accessKey : "h",
          popup : null,
          callback : function() {
            // Do nothing. The notification closes when this is called.
          }
        }
      ];
      const priority = notificationBox.PRIORITY_WARNING_LOW;
      let iconURI = "chrome://requestpolicy/skin/requestpolicy-icon-blocked.png";
      notificationBox.appendNotification(notificationLabel, notificationValue,
                                         iconURI, priority, buttons);
    }
  };

  /**
   * Shows a notification that a redirect was requested by a page (meta refresh
   * or with headers).
   *
   * @param {<browser> element} browser
   * @param {String}
   *          redirectTargetUri
   * @param {int}
   *          delay
   */
  self._showRedirectNotification = function(browser, redirectTargetUri, delay) {
    // TODO: Do something with the delay. Not sure what the best thing to do is
    // without complicating the UI.

    // TODO: The following error seems to be resulting when the notification
    // goes away with a redirect, either after clicking "allow" or if the
    // redirect is allowed and happens automatically.
    //
    // Source file: chrome://browser/content/browser.js
    // Line: 3704
    // ----------
    // Error: self._closedNotification.parentNode is null
    // Source file: chrome://global/content/bindings/notification.xml
    // Line: 260

    if (isFennec) {
      Logger.warning(Logger.TYPE_INTERNAL,
          "Should have shown redirect notification to <" + redirectTargetUri +
          ">, but it's not implemented yet on Fennec.");
      return;
    }

    var notificationBox = gBrowser.getNotificationBox(browser)
    var notificationValue = "request-policy-meta-redirect";

    // There doesn't seem to be a way to use the xul crop attribute with the
    // notification, so do our own cropping, showing at a minimum the entire
    // prePath.
    const maxLength = 50;
    if (redirectTargetUri.length < maxLength) {
      var shortUri = redirectTargetUri;
    } else {
      var prePathLength = DomainUtil.getPrePath(redirectTargetUri).length + 1;
      shortUri = redirectTargetUri
          .substring(0, Math.max(prePathLength, maxLength)) + "...";
    }
    var notificationLabel = StringUtils.strbundle.formatStringFromName(
        "redirectNotification", [shortUri], 1);

    var notificationButtonOptions = StringUtils.strbundle.GetStringFromName("more");
    var notificationButtonOptionsKey = StringUtils.strbundle
        .GetStringFromName("more.accesskey");
    var notificationButtonAllow = StringUtils.strbundle.GetStringFromName("allow");
    var notificationButtonAllowKey = StringUtils.strbundle
        .GetStringFromName("allow.accesskey");
    var notificationButtonDeny = StringUtils.strbundle.GetStringFromName("deny");
    var notificationButtonDenyKey = StringUtils.strbundle
        .GetStringFromName("deny.accesskey");

    var optionsPopupName = "requestpolicyRedirectNotificationOptions";
    var optionsPopup = document.getElementById(optionsPopupName);
    while (optionsPopup.firstChild) {
      optionsPopup.removeChild(optionsPopup.firstChild);
    }

    var origin = requestpolicy.menu._addWildcard(
        DomainUtil.getBaseDomain(self.getTopLevelDocumentUri()));
    var dest = requestpolicy.menu._addWildcard(
        DomainUtil.getBaseDomain(redirectTargetUri));

    requestpolicy.classicmenu.
        addMenuItemTemporarilyAllowDest(optionsPopup, dest);
    requestpolicy.classicmenu.addMenuItemAllowDest(optionsPopup, dest);
    requestpolicy.classicmenu.addMenuSeparator(optionsPopup);

    requestpolicy.classicmenu.
        addMenuItemTemporarilyAllowOrigin(optionsPopup, origin);
    requestpolicy.classicmenu.addMenuItemAllowOrigin(optionsPopup, origin);
    requestpolicy.classicmenu.addMenuSeparator(optionsPopup);

    requestpolicy.classicmenu.
        addMenuItemTemporarilyAllowOriginToDest(optionsPopup, origin, dest);
    requestpolicy.classicmenu.
        addMenuItemAllowOriginToDest(optionsPopup, origin, dest);




    var notification = notificationBox
        .getNotificationWithValue(notificationValue);
    if (notification) {
      notification.label = notificationLabel;
    } else {
      var buttons = [
        {
          label : notificationButtonAllow,
          accessKey : notificationButtonAllowKey,
          popup : null,
          callback : function() {
            // Fx 3.7a5+ calls shouldLoad for location.href changes.
            RequestProcessor.registerAllowedRedirect(
                browser.documentURI.specIgnoringRef, redirectTargetUri);

            browser.messageManager.sendAsyncMessage(MMID + ":setLocation",
                {uri: redirectTargetUri});
          }
        },
        {
          label : notificationButtonDeny,
          accessKey : notificationButtonDenyKey,
          popup : null,
          callback : function() {
            // Do nothing. The notification closes when this is called.
          }
        },
        {
          label : notificationButtonOptions,
          accessKey : notificationButtonOptionsKey,
          popup : optionsPopupName,
          callback : null
        }
      ];
      const priority = notificationBox.PRIORITY_WARNING_MEDIUM;
      notificationBox.appendNotification(notificationLabel, notificationValue,
          "chrome://browser/skin/Info.png", priority, buttons);
    }
  };


  /**
   * Performs actions required to be performed after a tab change.
   */
  self.tabChanged = function() {
    // TODO: verify the Fennec and all supported browser versions update the
    // status bar properly with only the ProgressListener. Once verified,
    // remove calls to tabChanged();
    // self._updateBlockedContentState(content.document);
  };

  self._containsNonBlacklistedRequests = function(requests) {
    for (let i = 0, len = requests.length; i < len; i++) {
      if (!requests[i].isOnBlacklist()) {
        // This request has not been blocked by the blacklist
        return true;
      }
    }
    return false;
  };

  /**
   * Checks if the document has blocked content and shows appropriate
   * notifications.
   */
  self._updateBlockedContentState = function() {
    try {
      let browser = gBrowser.selectedBrowser;
      let uri = DomainUtil.stripFragment(browser.currentURI.spec);
      Logger.debug(Logger.TYPE_INTERNAL,
          "Checking for blocked requests from page <" + uri + ">");

      // TODO: this needs to be rewritten. checking if there is blocked
      // content could be done much more efficiently.
      let documentContainsBlockedContent = RequestProcessor
          .getAllRequestsInBrowser(browser).containsBlockedRequests();
      self._setContentBlockedState(documentContainsBlockedContent);

      let logText = documentContainsBlockedContent ?
                    "Requests have been blocked." :
                    "No requests have been blocked.";
      Logger.debug(Logger.TYPE_INTERNAL, logText);
    } catch (e) {
      Logger.severeError(
          "Unable to complete _updateBlockedContentState actions: " + e, e);
    }
  };

  /**
   * Sets the blocked content notifications visible to the user.
   */
  self._setContentBlockedState = function(isContentBlocked) {
    var button = document.getElementById(toolbarButtonId);
    if (button) {
      button.setAttribute("requestpolicyBlocked", isContentBlocked);
    }
  };

  /**
   * Sets the permissive status visible to the user for all windows.
   */
  self._setPermissiveNotificationForAllWindows = function(isPermissive) {
    // We do it for all windows, not just the current one.
    var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
        .getService(Components.interfaces.nsIWindowMediator);
    var enumerator = wm.getEnumerator(null);
    while (enumerator.hasMoreElements()) {
      var window = enumerator.getNext();
      if ("requestpolicy" in window && "overlay" in window.requestpolicy) {
        window.requestpolicy.overlay._setPermissiveNotification(isPermissive);
      }
    }
  };

  /**
   * Sets the permissive status visible to the user for just this window.
   */
  self._setPermissiveNotification = function(isPermissive) {
    var button = document.getElementById(toolbarButtonId);
    if (button) {
      button.setAttribute("requestpolicyPermissive", isPermissive);
    }
  };

  /**
   * This function is called when any allowed requests happen. This must be as
   * fast as possible because request processing blocks until this function
   * returns.
   *
   * @param {}
   *          originUri
   * @param {}
   *          destUri
   */
  self.observeAllowedRequest = function(originUri, destUri) {
    if (self.requestLog) {
      self.requestLog.addAllowedRequest(originUri, destUri);
    }
  };

  /**
   * This function is called when any blocked requests happen. This must be as
   * fast as possible because request processing blocks until this function
   * returns.
   *
   * @param {}
   *          originUri
   * @param {}
   *          destUri
   */
  self.observeBlockedRequest = function(originUri, destUri) {
    self._updateNotificationDueToBlockedContent();
    if (self.requestLog) {
      self.requestLog.addBlockedRequest(originUri, destUri);
    }
  };

  self.observeBlockedLinkClickRedirect = function(sourcePageUri, linkDestUri,
      blockedRedirectUri) {
    // TODO: Figure out a good way to notify the user. For now, it should at
    // least be showing up in the menu the first time it happens. After that,
    // some caching issues seem to get in the way and the blocked request
    // isn't tried again, so there's no awareness of it.
    Logger.warning(Logger.TYPE_HEADER_REDIRECT,
        "Observed blocked link click redirect from page <" + sourcePageUri
            + "> with redirect origin <" + linkDestUri
            + "> and redirect dest <" + blockedRedirectUri
            + ">. --- WARNING: other than the menu "
            + "showing this blocked request, there is no other indication.");
  };

  /**
   * If the RP service noticed a blocked top-level document request, look for
   * a tab where the current location is the same as the origin of the blocked
   * request. If we find one, show a redirect notification. Note that if there
   * is more than one tab in this window open to the same origin, then we only
   * show the notification in the first one we find. However, if there are
   * multiple windows open and two different windows have a tab open to this
   * same origin, then the first tab at that location in each window will show
   * the redirect notification. This is because the RP service informs each
   * window separately to look for a document to show a notification in.
   */
  self.observeBlockedTopLevelDocRequest = function (originUri, destUri) {
    const browser = self._getBrowserAtUri(originUri);
    if (!browser) {
      return;
    }
    // We're called indirectly from shouldLoad so we can't block.
    window.setTimeout(function() {
      requestpolicy.overlay._showRedirectNotification(browser, destUri, 0);
    }, 0);
  };

  self._getBrowserAtUri = function(uri) {
    for (let i = 0, len = gBrowser.browsers.length; i < len; i++) {
      if (gBrowser.getBrowserAtIndex(i).currentURI.spec == uri) {
        return gBrowser.getBrowserAtIndex(i);
      }
    }
    return null;
  };

  // TODO: observeBlockedFormSubmissionRedirect

  self._updateNotificationDueToBlockedContent = function() {
    if (!blockedContentCheckTimeoutId) {
      self._updateBlockedContentStateAfterTimeout();
    }
  };

  self._updateBlockedContentStateAfterTimeout = function() {
    const browser = gBrowser.selectedBrowser;
    blockedContentCheckTimeoutId = window.setTimeout(function() {
      requestpolicy.overlay._updateBlockedContentState(browser);
    }, blockedContentStateUpdateDelay);
  };

  self._stopBlockedContentCheckTimeout = function() {
    if (blockedContentCheckTimeoutId) {
      window.clearTimeout(blockedContentCheckTimeoutId);
      blockedContentCheckTimeoutId = null;
    }
  };

  /**
   * Called as an event listener when popupshowing fires on the
   * contentAreaContextMenu.
   */
  self._contextMenuOnPopupShowing = function() {
    requestpolicy.overlay._wrapOpenLink();
    /*requestpolicy.overlay._attachPopupToContextMenu();*/
  };

  /**
   * Called as an event listener when popuphidden fires on the
   * contentAreaContextMenu.
   */
  //_contextMenuOnPopupHidden : function(event) {
  //  if (event.currentTarget != event.originalTarget) {
  //    return;
  //  }
  //  /*requestpolicy.overlay._attachPopupToStatusbar();*/
  //},

  /**
   * Wraps (overrides) the following methods of gContextMenu
   * - openLink()
   * - openLinkInPrivateWindow()
   * - openLinkInCurrent()
   * so that RequestPolicy can register a link-click.
   *
   * The original methods are defined in Firefox' nsContextMenu.js:
   * http://mxr.mozilla.org/mozilla-central/source/browser/base/content/nsContextMenu.js
   *
   * The openLinkInTab() method doesn't need to be wrapped because new tabs are already
   * recognized by tabAdded(), which is wrapped elsewhere. The tabAdded() function ends up
   * being called when openLinkInTab() is called.
   *
   * TODO: There are even more similar methods in gContextMenu (frame-specific),
   *       and perhaps the number will increase in future. Frame-specific contextMenu-
   *       entries are working, but are registered e.g. as "new window opened" by
   *       the subsequent shouldLoad() call.
   */
  self._wrapOpenLink = function() {
    if (!gContextMenu.requestpolicyMethodsOverridden) {
      gContextMenu.requestpolicyMethodsOverridden = true;

      gContextMenu.openLink = function() {
        RequestProcessor.registerLinkClicked(this.target.ownerDocument.URL, this.linkURL);
        return this.__proto__.openLink.call(this); // call the overridden method
      };

      // Below, we check whether the functions exist before overriding it, because
      // those functions have been introduced in later versions of Firefox than openLink().

      if (gContextMenu.openLinkInPrivateWindow) {
        gContextMenu.openLinkInPrivateWindow = function() {
          RequestProcessor.registerLinkClicked(this.target.ownerDocument.URL, this.linkURL);
          return this.__proto__.openLinkInPrivateWindow.call(this);
        };
      }

      if (gContextMenu.openLinkInCurrent) {
        gContextMenu.openLinkInCurrent = function() {
          RequestProcessor.registerLinkClicked(this.target.ownerDocument.URL, this.linkURL);
          return this.__proto__.openLinkInCurrent.call(this);
        };
      }
    }
  };

  /**
   * Modifies the addTab() function so that RequestPolicy can be aware of the
   * tab being opened. Assume that if the tab is being opened, it was an action
   * the user wanted (e.g. the equivalent of a link click). Using a TabOpen
   * event handler, I was unable to determine the referrer, so that approach
   * doesn't seem to be an option. This doesn't actually wrap addTab because the
   * extension TabMixPlus modifies the function rather than wraps it, so
   * wrapping it will break tabs if TabMixPlus is installed.
   */
  self._wrapAddTab = function() {
    if (!gBrowser.requestpolicyAddTabModified) {
      gBrowser.requestpolicyAddTabModified = true;

      // For reference, the addTab() function signature looks like this:
      // function addTab(aURI, aReferrerURI, aCharset, aPostData, aOwner,
      // aAllowThirdPartyFixup) {";
      // where it's possible that only two arguments are used and aReferrerURI
      // is a hash of the other arguments as well as new ones.
      // See https://github.com/RequestPolicyContinued/requestpolicy/issues/38

      // In order to keep our code from breaking if the signature of addTab
      // changes (even just a change in variable names, for example), we'll
      // simply insert our own line right after the first curly brace in the
      // string representation of the addTab function.
      var addTabString = gBrowser.addTab.toString();
      var firstCurlyBrace = addTabString.indexOf("{");
      var addTabParts = [];
      // Includes the '{'
      addTabParts[0] = addTabString.substring(0, firstCurlyBrace + 1);
      // Starts after the '{'
      addTabParts[1] = addTabString.substring(firstCurlyBrace + 1);

      // We use 'arguments' so that we aren't dependent on the names of two
      // parameters, as it seems not unlikely that these could change due to
      // the second parameter's purpose having been changed.
      var newFirstCodeLine = "\n    requestpolicy.overlay.tabAdded(arguments[0], arguments[1]);";
      // Finally, add our line to the beginning of the addTab function.
      eval("gBrowser.addTab = " + addTabParts[0] + newFirstCodeLine
          + addTabParts[1]);
    }
  };

  /**
   * This is called by the modified addTab().
   *
   * @param {String}
   *          url
   * @param {nsIURI/hash}
   *          referrerURI
   */
  self.tabAdded = function(url, referrerURI) {
    // The second argument to addTab was changed to a hash.
    // See https://github.com/RequestPolicyContinued/requestpolicy/issues/38
    if (referrerURI && !(referrerURI instanceof Components.interfaces.nsIURI)) {
      if ("referrerURI" in referrerURI) {
        referrerURI = referrerURI.referrerURI;
      } else {
        referrerURI = null;
      }
    }
    if (referrerURI) {
      RequestProcessor.registerLinkClicked(referrerURI.spec, url);
    }
  };

  self._addLocationObserver = function() {
    self.locationListener = {
      onLocationChange : function(aProgress, aRequest, aURI) {
        // This gets called both for tab changes and for history navigation.
        // The timer is running on the main window, not the document's window,
        // so we want to stop the timer when the tab is changed.
        requestpolicy.overlay._stopBlockedContentCheckTimeout();
        requestpolicy.overlay
            ._updateBlockedContentState(gBrowser.selectedBrowser);
      },
      // Though unnecessary for Gecko 2.0, I'm leaving in onSecurityChange for
      // SeaMonkey because of https://bugzilla.mozilla.org/show_bug.cgi?id=685466
      onSecurityChange : function() {
      },

      QueryInterface : function(aIID) {
        if (aIID.equals(Components.interfaces.nsIWebProgressListener)
            || aIID.equals(Components.interfaces.nsISupportsWeakReference)
            || aIID.equals(Components.interfaces.nsISupports))
          return this;
        throw Components.results.NS_NOINTERFACE;
      }
    };

    // https://developer.mozilla.org/en/Code_snippets/Progress_Listeners
    // "Starting in Gecko 2.0, all events are optional. The tabbrowser only
    // notifies you of the events for which you provide a callback."
    gBrowser.addProgressListener(self.locationListener);
  };

  self._removeLocationObserver = function() {
    gBrowser.removeProgressListener(self.locationListener);
  };

  self._addHistoryObserver = function() {
    // Implements nsISHistoryListener (and nsISupportsWeakReference)
    self.historyListener = {
      OnHistoryGoBack : function(backURI) {
        RequestProcessor.registerHistoryRequest(backURI.asciiSpec);
        return true;
      },

      OnHistoryGoForward : function(forwardURI) {
        RequestProcessor.registerHistoryRequest(forwardURI.asciiSpec);
        return true;
      },

      OnHistoryGotoIndex : function(index, gotoURI) {
        RequestProcessor.registerHistoryRequest(gotoURI.asciiSpec);
        return true;
      },

      OnHistoryNewEntry : function(newURI) {
      },

      OnHistoryPurge : function(numEntries) {
        return true;
      },

      OnHistoryReload : function(reloadURI, reloadFlags) {
        return true;
      },

      QueryInterface : function(aIID, aResult) {
        if (aIID.equals(Components.interfaces.nsISHistoryListener)
            || aIID.equals(Components.interfaces.nsISupportsWeakReference)
            || aIID.equals(Components.interfaces.nsISupports)) {
          return this;
        }
        throw Components.results.NS_NOINTERFACE;
      },

      GetWeakReference : function() {
        return Components.classes["@mozilla.org/appshell/appShellService;1"]
            .createInstance(Components.interfaces.nsIWeakReference);
      }
    };

    // there seems to be a bug in Firefox ESR 24 – the session history is
    // null. After waiting a few miliseconds it's available. To be sure this
    let tries = 0, waitTime = 20, maxTries = 10;
    let tryAddingSHistoryListener = function() {
      ++tries;
      try {
        let sHistory = gBrowser.webNavigation.sessionHistory;
        sHistory.addSHistoryListener(self.historyListener);
        return;
      } catch (e) {
        if (tries >= maxTries) {
          Logger.severeError("Can't add session history listener, even " +
              "after " + tries + " tries. "+e, e);
          return;
        }
        // call this function again in a few miliseconds.
        setTimeout(tryAddingSHistoryListener, waitTime);
      }
    };
    tryAddingSHistoryListener();
  };

  self._removeHistoryObserver = function() {
    var sHistory = gBrowser.webNavigation.sessionHistory;
    try {
      sHistory.removeSHistoryListener(self.historyListener);
    } catch (e) {
      // When closing the last window in a session where additional windows
      // have been opened and closed, this will sometimes fail (bug #175).
    }
  };

  /**
   * Called before the popup menu is shown.
   *
   * @param {Event}
   *          event
   */
  self.onPopupShowing = function(event) {
  //    if (event.currentTarget != event.originalTarget) {
  //      return;
  //    }
    requestpolicy.menu.prepareMenu();
  };

  /**
   * Called after the popup menu has been hidden.
   *
   * @param {Event}
   *          event
   */
  self.onPopupHidden = function(event) {
    var rulesChanged = requestpolicy.menu.processQueuedRuleChanges();
    if (rulesChanged || self._needsReloadOnMenuClose) {
      if (rpPrefBranch.getBoolPref("autoReload")) {
        let mm = gBrowser.selectedBrowser.messageManager;
        mm.sendAsyncMessage(MMID + ":reload");
      }
    }
    self._needsReloadOnMenuClose = false;
  //    if (event.currentTarget != event.originalTarget) {
  //      return;
  //    }
    // Leave the popup attached to the context menu, as we consider that the
    // default location for it.
    //self._attachPopupToContextMenu();
  };

  /**
   * Determines the top-level document's uri identifier based on the current
   * identifier level setting.
   *
   * @return {String} The current document's identifier.
   */
  self.getTopLevelDocumentUriIdentifier = function() {
    return DomainUtil.getIdentifier(self.getTopLevelDocumentUri());
  };

  /**
   * Get the top-level document's uri.
   */
  self.getTopLevelDocumentUri = function() {
    let uri = gBrowser.selectedBrowser.currentURI.spec;
    return rpService.getTopLevelDocTranslation(uri) ||
        DomainUtil.stripFragment(uri);
  };

  /**
   * Toggles disabling of all blocking for the current session.
   *
   * @param {Event}
   *          event
   */
  self.toggleTemporarilyAllowAll = function(event) {
    var disabled = !Prefs.isBlockingDisabled();
    Prefs.setBlockingDisabled(disabled);

    // Change the link displayed in the menu.
    document.getElementById('rp-link-enable-blocking').hidden = !disabled;
    document.getElementById('rp-link-disable-blocking').hidden = disabled;

    self._setPermissiveNotificationForAllWindows(disabled);
  };

  /**
   * Allows requests from the specified origin to any destination for the
   * duration of the browser session.
   */
  self.temporarilyAllowOrigin = function(originHost) {
    PolicyManager.temporarilyAllowOrigin(originHost);
  };

  /**
   * Allows the current document's origin to request from any destination for
   * the duration of the browser session.
   *
   * @param {Event}
   *          event
   */
  self.temporarilyAllowCurrentOrigin = function(event) {
    // Note: the available variable "content" is different than the avaialable
    // "window.target".
    var host = self.getTopLevelDocumentUriIdentifier();
    PolicyManager.temporarilyAllowOrigin(host);
  };

  /**
   * Allows a destination to be requested from any origin for the duration of
   * the browser session.
   *
   * @param {String}
   *          destHost
   */
  self.temporarilyAllowDestination = function(destHost) {
    PolicyManager.temporarilyAllowDestination(destHost);
  };

  /**
   * Allows a destination to be requested from a single origin for the duration
   * of the browser session.
   *
   * @param {String}
   *          originHost
   * @param {String}
   *          destHost
   */
  self.temporarilyAllowOriginToDestination = function(originHost, destHost) {
    PolicyManager.temporarilyAllowOriginToDestination(originHost, destHost);
  };

  /**
   * Allows requests from an origin, including in future browser sessions.
   */
  self.allowOrigin = function(originHost) {
    PolicyManager.allowOrigin(originHost);
  };

  /**
   * Allows the current document's origin to request from any destination,
   * including in future browser sessions.
   *
   * @param {Event}
   *          event
   */
  self.allowCurrentOrigin = function(event) {
    var host = self.getTopLevelDocumentUriIdentifier();
    PolicyManager.allowOrigin(host);
  };

  /**
   * Allows requests to a destination, including in future browser sessions.
   *
   * @param {String}
   *          destHost
   */
  self.allowDestination = function(destHost) {
    PolicyManager.allowDestination(destHost);
  };

  /**
   * Allows requests to a destination from a single origin, including in future
   * browser sessions.
   *
   * @param {String}
   *          originHost
   * @param {String}
   *          destHost
   */
  self.allowOriginToDestination = function(originHost, destHost) {
    PolicyManager.allowOriginToDestination(originHost, destHost);
  };

  /**
   * Forbids an origin from requesting from any destination. This revoke's
   * temporary or permanent request permissions the origin had been given.
   */
  self.forbidOrigin = function(originHost) {
    rpService.forbidOrigin(originHost);
  };

  /**
   * Forbids the current document's origin from requesting from any destination.
   * This revoke's temporary or permanent request permissions the origin had
   * been given.
   *
   * @param {Event}
   *          event
   */
  self.forbidCurrentOrigin = function(event) {
    var host = self.getTopLevelDocumentUriIdentifier();
    rpService.forbidOrigin(host);
  };

  /**
   * Forbids a destination from being requested by any origin. This revoke's
   * temporary or permanent request permissions the destination had been given.
   *
   * @param {String}
   *          destHost
   */
  self.forbidDestination = function(destHost) {
    rpService.forbidDestination(destHost);
  };

  /**
   * Forbids a destination from being requested by a single origin. This
   * revoke's temporary or permanent request permissions the destination had
   * been given.
   *
   * @param {String}
   *          originHost
   * @param {String}
   *          destHost
   */
  self.forbidOriginToDestination = function(originHost, destHost) {
    rpService.forbidOriginToDestination(originHost, destHost);
  };

  /**
   * Revokes all temporary permissions granted during the current session.
   *
   * @param {Event}
   *          event
   */
  self.revokeTemporaryPermissions = function(event) {
    PolicyManager.revokeTemporaryRules();
    self._needsReloadOnMenuClose = true;
    popupElement.hidePopup();
  };

  self._openInNewTab = function(uri) {
    gBrowser.selectedTab = gBrowser.addTab(uri);
  };

  self.openMenuByHotkey = function() {
    // Ideally we'd put the popup in its normal place based on the rp toolbar
    // button but let's not count on that being visible. So, we'll be safe and
    // anchor it within the content element. However, there's no good way to
    // right-align a popup. So, we can either let it be left aligned or we can
    // figure out where we think the top-left corner should be. And that's what
    // we do.
    // The first time the width will be 0. The default value is determined by
    // logging it or you can probably figure it out from the CSS which doesn't
    // directly specify the width of the entire popup.
    //Logger.dump('popup width: ' + popup.clientWidth);
    var popupWidth = popupElement.clientWidth ? 730 : popupElement.clientWidth;
    var anchor = document.getElementById('content');
    var contentWidth = anchor.clientWidth;
    // Take a few pixels off so it doesn't cover the browser chrome's border.
    var xOffset = contentWidth - popupWidth - 2;
    popupElement.openPopup(anchor, 'overlap', xOffset);
  };

  //  showExtensionConflictInfo : function() {
  //    var ext = rpService.getConflictingExtensions();
  //    var extJson = JSON.stringify(ext);
  //    self._openInNewTab(self._extensionConflictInfoUri
  //        + encodeURIComponent(extJson));
  //  },

  //  showPrefetchInfo : function() {
  //    self._openInNewTab(self._prefetchInfoUri);
  //  },
  //
  //  showPrefetchDisablingInstructions : function() {
  //    self._openInNewTab(self._prefetchDisablingInstructionsUri);
  //  },

  self.openToolbarPopup = function(anchor) {
  //    requestpolicy.overlay._toolbox.insertBefore(requestpolicy.overlay.popupElement,
  //        null);
    popupElement.openPopup(anchor, 'after_start', 0, 0, true, true);
  };

  function openLinkInNewTab(url, relatedToCurrent) {
    window.openUILinkIn(url, "tab", {relatedToCurrent: !!relatedToCurrent});
    popupElement.hidePopup();
  }

  self.openPrefs = openLinkInNewTab.bind(this, 'about:requestpolicy', true);
  self.openPolicyManager = openLinkInNewTab.bind(this,
      'about:requestpolicy?yourpolicy', true);
  self.openHelp = openLinkInNewTab.bind(this,
      'https://github.com/RequestPolicyContinued/requestpolicy/wiki/Help-and-Support');


  self.clearRequestLog = function() {
    self.requestLog.clear();
  };

  self.toggleRequestLog = function() {
    var requestLog = document.getElementById("requestpolicy-requestLog");
    var requestLogSplitter = document.getElementById("requestpolicy-requestLog-splitter");
    var requestLogFrame = document.getElementById("requestpolicy-requestLog-frame");
    //var openRequestLog = document.getElementById("requestpolicyOpenRequestLog");

    // TODO: figure out how this should interact with the new menu.
    //var closeRequestLog = document
    //    .getElementById("requestpolicyCloseRequestLog");
    var closeRequestLog = {};

    if (requestLog.hidden) {
      requestLogFrame.setAttribute("src",
          "chrome://requestpolicy/content/ui/request-log.xul");
      requestLog.hidden = requestLogSplitter.hidden = closeRequestLog.hidden = false;
      //openRequestLog.hidden = true;
    } else {
      requestLogFrame.setAttribute("src", "about:blank");
      requestLog.hidden = requestLogSplitter.hidden = closeRequestLog.hidden = true;
      //openRequestLog.hidden = false;
      self.requestLog = null;
    }
  };

  return self;
}());