const checkbox = document.getElementById('autoHoverMode');
const DEFAULTS = { autoHoverMode: false };

chrome.storage.sync.get(DEFAULTS, (settings) => {
  checkbox.checked = Boolean(settings.autoHoverMode);
});

checkbox.addEventListener('change', () => {
  chrome.storage.sync.set({ autoHoverMode: checkbox.checked });
});

const versionText = document.getElementById('versionText');
if (versionText && chrome?.runtime?.getManifest) {
  versionText.textContent = `v${chrome.runtime.getManifest().version}`;
}
