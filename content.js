// == CS2 Price Alert Extension Logic ==
// This script waits for the Steam Market page to be ready,
// then injects the chart and alert UI.

(function() {
    'use strict';

    // --- Configuration ---
    const CHECK_INTERVAL_MS = 250; // How often to check if the page is ready
    const PRICE_CHECK_INTERVAL_MS = 15000; // How often to check for price alerts
    let priceCheckTimer = null;
    let g_ItemID = null; // Will be populated by tryToInitialize
    let g_ItemName = null; // Will be populated by tryToInitialize
    let g_Chart = null;
    let g_CandlestickSeries = null;
    let g_RawPriceHistory = [];
    let g_CurrentTimeframe = 'Day';

    // --- Aggregation Constants ---
    const ONE_HOUR = 60 * 60 * 1000;
    const ONE_DAY = 24 * ONE_HOUR;
    const ONE_WEEK = 7 * ONE_DAY;
    const ONE_MONTH = 30 * ONE_DAY; // Approximation

    /**
     * Tries to find the necessary Steam variables and DOM elements.
     * This function will retry until it succeeds.
     */
    function tryToInitialize() {
        // Try to find the item ID. Steam uses different variables.
        // 1. Check for the function that loads the graph (most reliable)
        if (typeof Market_LoadOrderSpread === 'function') {
            const funcString = Market_LoadOrderSpread.toString();
            const match = funcString.match(/g_rgHistory\[\s*(\d+)\s*\]/);
            if (match && match[1]) {
                g_ItemID = match[1];
            }
        }
        // 2. Fallback to global variable
        if (!g_ItemID && typeof g_ItemNameID !== 'undefined') {
            g_ItemID = g_ItemNameID;
        }

        // Try to find the item name (for notifications)
        if (typeof g_strMarketItemName !== 'undefined') {
            g_ItemName = g_strMarketItemName;
        } else {
            // Fallback to title
            const titleElement = document.getElementById('largeiteminfo_item_name');
            if (titleElement) {
                g_ItemName = titleElement.textContent.trim();
            } else {
                g_ItemName = "CS2 Item"; // Generic fallback
            }
        }

        // Try to find the DOM element to inject into
        const targetElement = document.getElementById('market_commodity_order_spread');

        if (g_ItemID && targetElement) {
            // Success! We found everything.
            console.log(`CS2 Alert: Initialized OK. ItemID: ${g_ItemID}, Target found.`);
            main(targetElement, g_ItemID);
        } else {
            // Retry
            if (!g_ItemID) console.log('CS2 Alert: Waiting for ItemID...');
            if (!targetElement) console.log('CS2 Alert: Waiting for target DOM element...');
            setTimeout(tryToInitialize, CHECK_INTERVAL_MS);
        }
    }

    /**
     * Main function, runs after the page is ready.
     * @param {HTMLElement} targetElement - The DOM element to inject into.
     * @param {string} itemID - The ItemNameID for this item.
     */
    async function main(targetElement, itemID) {
        // --- 1. Create UI Containers ---
        const chartContainer = document.createElement('div');
        chartContainer.id = 'cs2-chart-container';

        const uiContainer = document.createElement('div');
        uiContainer.id = 'cs2-ui-container';

        // Inject containers into the page
        targetElement.parentNode.insertBefore(chartContainer, targetElement.nextSibling);
        chartContainer.parentNode.insertBefore(uiContainer, chartContainer.nextSibling);

        // --- 2. Inject Timeframe/Zoom UI ---
        uiContainer.innerHTML = `
            <div class="cs2-control-group">
                <span class="cs2-label">Timeframe:</span>
                <button id="tf-hour" class="cs2-button" data-tf="Hour">Hour</button>
                <button id="tf-day" class="cs2-button active" data-tf="Day">Day</button>
                <button id="tf-week" class="cs2-button" data-tf="Week">Week</button>
                <button id="tf-month" class="cs2-button" data-tf="Month">Month</button>
            </div>
            <div class="cs2-control-group">
                <span class="cs2-label">Zoom:</span>
                <button id="zoom-1m" class="cs2-button" data-zoom="1M">1M</button>
                <button id="zoom-6m" class="cs2-button" data-zoom="6M">6M</button>
                <button id="zoom-1y" class="cs2-button" data-zoom="1Y">1Y</button>
                <button id="zoom-all" class="cs2-button active" data-zoom="All">All</button>
            </div>
            <div class="cs2-alert-form">
                <span class="cs2-label">Set Alert:</span>
                <input type="number" id="cs2-buy-price" placeholder="Buy if below...">
                <button id="cs2-set-buy" class="cs2-button set-alert">Set Buy</button>
                <input type="number" id="cs2-sell-price" placeholder="Sell if above...">
                <button id="cs2-set-sell" class="cs2-button set-alert">Set Sell</button>
                <button id="cs2-clear-alerts" class="cs2-button clear-alert">Clear All</button>
            </div>
            <div id="cs2-current-alerts"></div>
        `;

        // --- 3. Load Charting Library ---
        // We assume the library is loaded via web_accessible_resources
        // The script tag injection method is less reliable.
        if (typeof LightweightCharts === 'undefined') {
            console.error('CS2 Alert: LightweightCharts library not found!');
            chartContainer.innerText = 'Error: Charting library failed to load.';
            return;
        }

        // --- 4. Initialize Chart ---
        g_Chart = LightweightCharts.createChart(chartContainer, {
            width: chartContainer.clientWidth,
            height: 400,
            layout: {
                backgroundColor: '#171a21',
                textColor: '#d1d4dc',
            },
            grid: {
                vertLines: { color: '#242731' },
                horzLines: { color: '#242731' },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                borderColor: '#484c58',
            },
            rightPriceScale: {
                borderColor: '#484c58',
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
            },
        });

        g_CandlestickSeries = g_Chart.addCandlestickSeries({
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderDownColor: '#ef5350',
            borderUpColor: '#26a69a',
            wickDownColor: '#ef5350',
            wickUpColor: '#26a69a',
        });

        // Handle chart resizing
        new ResizeObserver(entries => {
            if (entries.length === 0 || entries[0].contentRect.width === 0) {
                return;
            }
            const { width, height } = entries[0].contentRect;
            g_Chart.resize(width, 400); // Keep height fixed
        }).observe(chartContainer);

        // --- 5. Fetch Price Data ---
        try {
            const response = await fetch(`https://steamcommunity.com/market/pricehistory/?appid=730&market_hash_name=${encodeURIComponent(g_ItemName)}`);
            if (!response.ok) throw new Error('Network response was not ok');
            
            const data = await response.json();
            if (!data.success || !data.prices) throw new Error('Failed to get price data');
            
            g_RawPriceHistory = data.prices;
            updateChartData(g_CurrentTimeframe); // Initial load
            applyZoom('All'); // Apply default zoom
        } catch (error) {
            console.error("CS2 Alert: Error fetching price data:", error);
            chartContainer.innerText = "Error loading chart data.";
            return;
        }

        // --- 6. Add Event Listeners ---
        addUIEventListeners();

        // --- 7. Load Alerts and Start Checker ---
        loadAndDisplayAlerts();
        startPriceCheckInterval();
    }

    /**
     * Converts raw price history (from Steam) into OHLC data for the chart.
     * @param {string} timeframe - "Hour", "Day", "Week", "Month"
     * @returns {Array<Object>} - Array of OHLC data points
     */
    function aggregateData(timeframe) {
        if (g_RawPriceHistory.length === 0) return [];

        let aggregationMillis;
        if (timeframe === 'Hour') aggregationMillis = ONE_HOUR;
        else if (timeframe === 'Week') aggregationMillis = ONE_WEEK;
        else if (timeframe === 'Month') aggregationMillis = ONE_MONTH;
        else aggregationMillis = ONE_DAY; // Default to Day

        const aggregatedData = new Map();

        for (const [timestampStr, price] of g_RawPriceHistory) {
            const timestamp = new Date(timestampStr).getTime();
            
            let keyTime;
            if (timeframe === 'Hour') {
                keyTime = Math.floor(timestamp / ONE_HOUR) * ONE_HOUR;
            } else if (timeframe === 'Week') {
                const day = new Date(timestamp).getUTCDay();
                const firstDayOfWeek = timestamp - (day * ONE_DAY); // Assuming Sunday is day 0
                keyTime = Math.floor(firstDayOfWeek / ONE_DAY) * ONE_DAY;
            } else if (timeframe === 'Month') {
                const date = new Date(timestamp);
                keyTime = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).getTime();
            } else { // Day
                keyTime = Math.floor(timestamp / ONE_DAY) * ONE_DAY;
            }

            const timeInSeconds = keyTime / 1000;

            if (!aggregatedData.has(timeInSeconds)) {
                aggregatedData.set(timeInSeconds, {
                    time: timeInSeconds,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    firstTimestamp: timestamp,
                    lastTimestamp: timestamp,
                });
            } else {
                const candle = aggregatedData.get(timeInSeconds);
                candle.high = Math.max(candle.high, price);
                candle.low = Math.min(candle.low, price);

                if (timestamp < candle.firstTimestamp) {
                    candle.open = price;
                    candle.firstTimestamp = timestamp;
                }
                if (timestamp > candle.lastTimestamp) {
                    candle.close = price;
                    candle.lastTimestamp = timestamp;
                }
            }
        }
        
        return Array.from(aggregatedData.values()).sort((a, b) => a.time - b.time);
    }

    /**
     * Updates the chart series with new aggregated data.
     * @param {string} timeframe - "Hour", "Day", "Week", "Month"
     */
    function updateChartData(timeframe) {
        g_CurrentTimeframe = timeframe;
        const ohlcData = aggregateData(timeframe);
        g_CandlestickSeries.setData(ohlcData);
        
        // Update active button state
        document.querySelectorAll('.cs2-control-group:first-child .cs2-button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tf === timeframe);
        });
    }

    /**
     * Applies a zoom level to the chart's time scale.
     * @param {string} zoom - "1M", "6M", "1Y", "All"
     */
    function applyZoom(zoom) {
        const data = g_CandlestickSeries.data();
        if (data.length === 0) return;

        let to = data[data.length - 1].time;
        let from;

        const now = new Date();
        if (zoom === '1M') {
            from = new Date(now.setUTCMonth(now.getUTCMonth() - 1)).getTime() / 1000;
        } else if (zoom === '6M') {
            from = new Date(now.setUTCMonth(now.getUTCMonth() - 6)).getTime() / 1000;
        } else if (zoom === '1Y') {
            from = new Date(now.setUTCFullYear(now.getUTCFullYear() - 1)).getTime() / 1000;
        } else { // All
            from = data[0].time;
            g_Chart.timeScale().fitContent();
            return; // fitContent handles this case
        }
        
        g_Chart.timeScale().setVisibleRange({ from, to });

        // Update active button state
        document.querySelectorAll('.cs2-control-group:nth-child(2) .cs2-button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.zoom === zoom);
        });
    }

    /**
     * Attaches event listeners to all UI elements.
     */
    function addUIEventListeners() {
        // Timeframe buttons
        document.getElementById('tf-hour').addEventListener('click', () => updateChartData('Hour'));
        document.getElementById('tf-day').addEventListener('click', () => updateChartData('Day'));
        document.getElementById('tf-week').addEventListener('click', () => updateChartData('Week'));
        document.getElementById('tf-month').addEventListener('click', () => updateChartData('Month'));

        // Zoom buttons
        document.getElementById('zoom-1m').addEventListener('click', () => applyZoom('1M'));
        document.getElementById('zoom-6m').addEventListener('click', () => applyZoom('6M'));
        document.getElementById('zoom-1y').addEventListener('click', () => applyZoom('1Y'));
        document.getElementById('zoom-all').addEventListener('click', () => applyZoom('All'));

        // Alert buttons
        document.getElementById('cs2-set-buy').addEventListener('click', setAlert);
        document.getElementById('cs2-set-sell').addEventListener('click', setAlert);
        document.getElementById('cs2-clear-alerts').addEventListener('click', clearAlerts);
    }

    /**
     * Saves an alert to chrome.storage.local
     */
    function setAlert(event) {
        const type = event.target.id === 'cs2-set-buy' ? 'buy' : 'sell';
        const input = document.getElementById(`cs2-${type}-price`);
        const price = parseFloat(input.value);

        if (!price || price <= 0) {
            console.log('CS2 Alert: Invalid price.');
            return;
        }

        const alert = { type, price };
        const key = `cs2_alert_${g_ItemID}`;

        chrome.storage.local.get([key], (result) => {
            const alerts = result[key] || [];
            // Remove existing alert of the same type
            const otherAlerts = alerts.filter(a => a.type !== type);
            const newAlerts = [...otherAlerts, alert];
            
            chrome.storage.local.set({ [key]: newAlerts }, () => {
                console.log(`CS2 Alert: ${type} alert set for ${price}`);
                input.value = '';
                loadAndDisplayAlerts();
            });
        });
    }

    /**
     * Loads and displays current alerts under the form.
     */
    function loadAndDisplayAlerts() {
        const key = `cs2_alert_${g_ItemID}`;
        const display = document.getElementById('cs2-current-alerts');
        
        chrome.storage.local.get([key], (result) => {
            const alerts = result[key] || [];
            display.innerHTML = ''; // Clear current
            
            if (alerts.length > 0) {
                let text = 'Current Alerts: ';
                alerts.forEach(a => {
                    if (a.type === 'buy') text += `<span>Buy below $${a.price.toFixed(2)}</span>`;
                    if (a.type === 'sell') text += `<span>Sell above $${a.price.toFixed(2)}</span>`;
                });
                display.innerHTML = text;
            }
        });
    }

    /**
     * Clears all alerts for this item.
     */
    function clearAlerts() {
        const key = `cs2_alert_${g_ItemID}`;
        chrome.storage.local.remove(key, () => {
            console.log('CS2 Alert: All alerts cleared for this item.');
            loadAndDisplayAlerts();
        });
    }

    /**
     * Starts the interval timer to check prices.
     */
    function startPriceCheckInterval() {
        if (priceCheckTimer) clearInterval(priceCheckTimer); // Clear existing
        priceCheckTimer = setInterval(checkPrices, PRICE_CHECK_INTERVAL_MS);
        console.log('CS2 Alert: Price checker started.');
        checkPrices(); // Check immediately
    }

    /**
     * Fetches the *current* price and checks against alerts.
     */
    async function checkPrices() {
        if (!g_ItemID) return; // Not initialized yet

        const key = `cs2_alert_${g_ItemID}`;
        chrome.storage.local.get([key], async (result) => {
            const alerts = result[key] || [];
            if (alerts.length === 0) {
                // No alerts for this item, no need to fetch price
                return;
            }

            try {
                // Use the same price history endpoint, as it's the most reliable
                // We only care about the *last* price in the array
                const response = await fetch(`https://steamcommunity.com/market/pricehistory/?appid=730&market_hash_name=${encodeURIComponent(g_ItemName)}`);
                if (!response.ok) return;
                
                const data = await response.json();
                if (!data.success || data.prices.length === 0) return;

                const lastSale = data.prices[data.prices.length - 1];
                const currentPrice = lastSale[1];
                
                console.log(`CS2 Alert: Price check - Current: $${currentPrice}`);

                const triggeredAlerts = [];
                const remainingAlerts = [];

                alerts.forEach(alert => {
                    if (alert.type === 'buy' && currentPrice <= alert.price) {
                        triggeredAlerts.push(alert);
                        sendNotification(`Buy Alert for ${g_ItemName}`, `Price reached $${currentPrice} (your target was $${alert.price})`);
                    } else if (alert.type === 'sell' && currentPrice >= alert.price) {
                        triggeredAlerts.push(alert);
                        sendNotification(`Sell Alert for ${g_ItemName}`, `Price reached $${currentPrice} (your target was $${alert.price})`);
                    } else {
                        remainingAlerts.push(alert); // Keep non-triggered alerts
                    }
                });

                if (triggeredAlerts.length > 0) {
                    // Remove triggered alerts from storage
                    chrome.storage.local.set({ [key]: remainingAlerts }, () => {
                        console.log('CS2 Alert: Triggered alerts removed.');
                        loadAndDisplayAlerts();
                    });
                }

            } catch (error) {
                console.error('CS2 Alert: Error during price check:', error);
            }
        });
    }

    /**
     * Sends a desktop notification.
     * @param {string} title - The notification title.
     * @param {string} message - The notification body.
     */
    function sendNotification(title, message) {
        // We must send a message to the background script to show a notification
        // Content scripts cannot show notifications directly.
        chrome.runtime.sendMessage({
            type: 'showNotification',
            options: {
                type: 'basic',
                iconUrl: chrome.runtime.getURL('icon.png'),
                title: title,
                message: message
            }
        });
    }

    // --- Start the initialization process ---
    tryToInitialize();

})();

