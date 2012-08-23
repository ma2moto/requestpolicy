function updateDisplay() {
  var defaultallow = rpService.prefs.getBoolPref('defaultPolicy.allow');
  if (defaultallow) {
    document.getElementById('defaultallow').checked = true;
    document.getElementById('defaultdenysetting').hidden = true;
  } else {
    document.getElementById('defaultdeny').checked = true;
    document.getElementById('defaultdenysetting').hidden = false;
  }

  var allowsamedomain = rpService.prefs.getBoolPref('defaultPolicy.allowSameDomain');
  document.getElementById('allowsamedomain').checked = allowsamedomain;
}

function showManageSubscriptionsLink() {
  document.getElementById('subscriptionschanged').style.display = 'block';
}

function onload() {
  updateDisplay();

  document.getElementById('defaultallow').addEventListener('change',
    function(event) {
      var allow = event.target.checked;
      rpService.prefs.setBoolPref('defaultPolicy.allow', allow);
      rpServiceJSObject._prefService.savePrefFile(null);
      // Reload all subscriptions because it's likely that different
      // subscriptions will now be active.
      switchSubscriptionPolicies();
      updateDisplay();
      showManageSubscriptionsLink();
    }
  );
  document.getElementById('defaultdeny').addEventListener('change',
    function(event) {
      var deny = event.target.checked;
      rpService.prefs.setBoolPref('defaultPolicy.allow', !deny);
      rpServiceJSObject._prefService.savePrefFile(null);
      // Reload all subscriptions because it's likely that different
      // subscriptions will now be active.
      switchSubscriptionPolicies();
      updateDisplay();
      showManageSubscriptionsLink();
    }
  );
  document.getElementById('allowsamedomain').addEventListener('change',
    function(event) {
      var allowSameDomain = event.target.checked;
      rpService.prefs.setBoolPref('defaultPolicy.allowSameDomain',
            allowSameDomain);
      rpServiceJSObject._prefService.savePrefFile(null);
    }
  );
}