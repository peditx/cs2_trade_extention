// This script listens for messages from content.js to show notifications
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'showNotification') {
        chrome.notifications.create(
            'cs2-alert-' + Date.now(), // A unique ID for the notification
            request.options
        );
    }
});
