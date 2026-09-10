// Live host entry: deliberately no synthetic payment authorizer.
import '/viewer.js';
const config=await fetch('/config.json').then(r=>r.json());
if(config.development!==false || config.fixture!==false) throw Error('LIVE_VIEWER_REQUIRED');
document.getElementById('provider').value=config.providerId;
document.getElementById('profile').value=config.profileId;
const banner=document.createElement('p');
banner.setAttribute('role','note');
banner.textContent='LIVE APPLICATION — owner-declared runtime; qualification comes from retained execution evidence, not this label. Signed receipts are claims; authorized replay is a separate assessment, not a cryptographic proof. Wallet signing must be supplied by a trusted host integration; no key entry or synthetic payment is available here.';
document.body.prepend(banner);
