/**
 * CS2 Price Alert & Chart Extension
 * This script injects a chart, buttons, and alert form into Steam Market pages.
 */
(async function() {
    
    // --- 0. Global Variables ---
    let marketHashName = '';
    let itemNameId = '';
    let currencyID = '';
    const priceCheckInterval = 15000; // Check prices every 15 seconds

    // Chart variables
    let chart;
    let candlestickSeries;
    let allTimeBaseData = []; // Raw data from API
    let hourlyOHLC = [];
    let dailyOHLC = [];
    let weeklyOHLC = [];
    let monthlyOHLC = [];

    // --- 1. Extract Initial Page Data ---
    try {
        marketHashName = decodeURIComponent(window.location.pathname.split('/').pop());
        
        // We need to parse the page's inline script to find the item ID and currency
        const pageScriptContent = document.documentElement.innerHTML;
        
        const nameIdMatch = pageScriptContent.match(/Market_ListenForBuyOrder\(\s*[^,]+,\s*(\d+)/);
        if (nameIdMatch) {
            itemNameId = nameIdMatch[1];
        } else {
            console.error("CS2 Alert: Could not find ItemNameID.");
        }

        const currencyMatch = pageScriptContent.match(/wallet_currency":(\d+)/);
        if (currencyMatch) {
            currencyID = currencyMatch[1];
        } else {
            console.error("CS2 Alert: Could not find currencyID.");
        }

    } catch (e) {
        console.error("CS2 Alert: Error initializing:", e);
        return; // Stop execution if we can't get basic info
    }

    // --- 2. Create and Inject UI Elements ---
    
    // --- A) Chart Container
    const chartContainer = document.createElement('div');
    chartContainer.id = 'my-cs2-chart-container';
    const messageBox = document.createElement('div');
    messageBox.className = 'cs2-message-box';
    chartContainer.appendChild(messageBox);

    // --- B) Chart Control Buttons (Timeframe/Zoom)
    const chartControls = document.createElement('div');
    chartControls.className = 'cs2-chart-controls';
    chartControls.innerHTML = `
        <div class="cs2-btn-group" id="aggregation-group">
            <button class="cs2-btn" data-timeframe="hour">Hour</button>
            <button class="cs2-btn active" data-timeframe="day">Day</button>
            <button class="cs2-btn" data-timeframe="week">Week</button>
            <button class="cs2-btn" data-timeframe="month">Month</button>
        </div>
        <div class="cs2-btn-group" id="zoom-group">
            <button class="cs2-btn" data-zoom="1M">1M</button>
            <button class="cs2-btn" data-zoom="6M">6M</button>
            <button class="cs2-btn" data-zoom="1Y">1Y</button>
            <button class="cs2-btn active" data-zoom="All">All</button>
        </div>
    `;

    // --- C) Alert Control Form
    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'cs2-alert-controls';
    controlsContainer.innerHTML = `
        <div class="cs2-control-group">
            <label for="alert-buy-price">Alert if price drops to (Buy):</label>
            <input type="text" id="alert-buy-price" placeholder="e.g., 0.10">
        </div>
        <div class="cs2-control-group">
            <label for="alert-sell-price">Alert if price rises to (Sell):</label>
            <input type="text" id="alert-sell-price" placeholder="e.g., 5.50">
        </div>
        <button id="set-alerts-btn">Set Alerts</button>
        <button id="clear-alerts-btn">Clear Alerts</button>
        <div id="active-alerts-display"></div>
    `;

    // Inject all elements into the page
    const targetElement = document.getElementById('market_commodity_order_spread');
    if (targetElement) {
        // Inject in order: Chart, Chart Controls, Alert Form
        targetElement.parentNode.insertBefore(chartContainer, targetElement);
        chartContainer.after(chartControls);
        chartControls.after(controlsContainer);
    } else {
        console.error("CS2 Alert: Could not find target element to inject chart.");
        return;
    }

    // --- 3. Add Event Listeners ---
    
    // --- A) Alert Form Listeners
    document.getElementById('set-alerts-btn').addEventListener('click', handleSetAlerts);
    document.getElementById('clear-alerts-btn').addEventListener('click', handleClearAlerts);

    // --- B) Chart Button Listeners
    document.getElementById('aggregation-group').addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
            handleAggregationChange(e.target);
        }
    });
    document.getElementById('zoom-group').addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
            handleZoomChange(e.target);
        }
    });

    // --- 4. Load Chart Data and Start Price Loop ---
    showMessage("Loading chart data...", "loading");
    try {
        await loadAndRenderChart();
        hideMessage();
    } catch (error) {
        console.error("CS2 Chart: Error loading chart:", error);
        showMessage(error.message, "error");
    }
    
    await loadAlertsFromStorage(); // Load saved alerts
    startPriceCheckLoop(); // Start checking for alert prices

    // --- 5. Core Functions ---

    /**
     * Loads the chart library, fetches data, aggregates it, and renders the chart.
     */
    async function loadAndRenderChart() {
        // 1. Wait for lightweight-charts to be available (it's loaded by manifest.json)
        // This check ensures the library is ready before we use it.
        await new Promise(resolve => {
            const interval = setInterval(() => {
                if (typeof LightweightCharts !== 'undefined') {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });
        
        // 2. Fetch price history data
        const url = `https://steamcommunity.com/market/pricehistory/?appid=730&market_hash_name=${encodeURIComponent(marketHashName)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();
        if (!data.success || !data.prices) throw new Error('Failed to get price data');
        
        allTimeBaseData = data.prices;

        // 3. Aggregate data for all timeframes
        hourlyOHLC  = aggregateData(allTimeBaseData, 'hour');
        dailyOHLC   = aggregateData(allTimeBaseData, 'day');
        weeklyOHLC  = aggregateData(allTimeBaseData, 'week');
        monthlyOHLC = aggregateData(allTimeBaseData, 'month');

        // 4. Create the chart
        chart = LightweightCharts.createChart(chartContainer, {
            width: chartContainer.clientWidth,
            height: 400,
            layout: { backgroundColor: '#171a21', textColor: '#d1d4dc' },
            grid: { vertLines: { color: '#242731' }, horzLines: { color: '#242731' } },
            timeScale: { timeVisible: true, secondsVisible: false },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        });

        candlestickSeries = chart.addCandlestickSeries({
            upColor: '#26a69a', downColor: '#ef5350',
            borderDownColor: '#ef5350', borderUpColor: '#26a69a',
            wickDownColor: '#ef5350', wickUpColor: '#26a69a',
        });

        // 5. Set initial data (Daily) and fit content
        candlestickSeries.setData(dailyOHLC);
        chart.timeScale().fitContent();

        // 6. Handle chart resize automatically
        new ResizeObserver(entries => {
            if (entries[0] && entries[0].contentRect.width) {
                chart.applyOptions({ width: entries[0].contentRect.width });
            }
        }).observe(chartContainer);
    }

    /**
     * Aggregates raw price data into OHLC candles for a specific timeframe.
     * @param {Array} prices - Raw data from API [timestamp, price, volume]
     * @param {String} timeframe - 'hour', 'day', 'week', 'month'
     * @returns {Array} - OHLC data array for the chart
     */
    function aggregateData(prices, timeframe) {
        const aggregatedData = {};

        // Helper function to get the correct UTC timestamp key for aggregation
        const getKey = (date) => {
            const y = date.getUTCFullYear();
            const m = date.getUTCMonth();
            const d = date.getUTCDate();
            
            switch (timeframe) {
                case 'hour':
                    // Key by the hour
                    return new Date(Date.UTC(y, m, d, date.getUTCHours())).getTime() / 1000;
                case 'day':
                    // Key by the day
                    return new Date(Date.UTC(y, m, d)).getTime() / 1000;
                case 'week':
                    // Key by the start of the week (Sunday)
                    const firstDayOfWeek = new Date(Date.UTC(y, m, d));
                    firstDayOfWeek.setUTCDate(d - date.getUTCDay()); // 0 = Sunday
                    return firstDayOfWeek.getTime() / 1000;
                case 'month':
                    // Key by the first day of the month
                    return new Date(Date.UTC(y, m, 1)).getTime() / 1000;
                default:
                    return new Date(Date.UTC(y, m, d)).getTime() / 1000;
            }
        };

        for (const [timestampStr, price, volume] of prices) {
            const date = new Date(timestampStr);
            const key = getKey(date);
            
            if (!aggregatedData[key]) {
                // First trade for this candle
                aggregatedData[key] = {
                    time: key,
                    open: price, high: price, low: price, close: price,
                    firstTimestamp: date.getTime(), lastTimestamp: date.getTime(),
                };
            } else {
                // Update existing candle
                const candle = aggregatedData[key];
                candle.high = Math.max(candle.high, price);
                candle.low = Math.min(candle.low, price);
                
                // Update open/close based on which trade was first/last
                if (date.getTime() < candle.firstTimestamp) {
                    candle.open = price;
                    candle.firstTimestamp = date.getTime();
                }
                if (date.getTime() > candle.lastTimestamp) {
                    candle.close = price;
                    candle.lastTimestamp = date.getTime();
                }
            }
        }
        // Convert map to array and sort by time
        return Object.values(aggregatedData).sort((a, b) => a.time - b.time);
    }

    /**
     * Handles clicks on timeframe buttons (Hour, Day, etc.)
     */
    function handleAggregationChange(button) {
        const timeframe = button.dataset.timeframe;
        if (button.classList.contains('active')) return;

        // Update button UI
        document.querySelectorAll('#aggregation-group .cs2-btn').forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');

        // Set new data on the chart
        switch (timeframe) {
            case 'hour':
                candlestickSeries.setData(hourlyOHLC);
                break;
            case 'day':
                candlestickSeries.setData(dailyOHLC);
                break;
            case 'week':
                candlestickSeries.setData(weeklyOHLC);
                break;
            case 'month':
                candlestickSeries.setData(monthlyOHLC);
                break;
        }
        // Re-apply the current zoom setting
        handleZoomChange(document.querySelector('#zoom-group .cs2-btn.active'));
    }

    /**
     * Handles clicks on zoom buttons (1M, 6M, etc.)
     */
    function handleZoomChange(button) {
        const zoom = button.dataset.zoom;
        if (!chart) return;

        // Update button UI
        document.querySelectorAll('#zoom-group .cs2-btn').forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');

        if (zoom === 'All') {
            chart.timeScale().fitContent();
            return;
        }

        // Calculate 'from' timestamp
        const now = new Date();
        const to = Math.floor(now.getTime() / 1000); // UTC timestamp
        let from;

        switch (zoom) {
            case '1M':
                from = Math.floor(new Date(now.setMonth(now.getMonth() - 1)).getTime() / 1000);
                break;
            case '6M':
                from = Math.floor(new Date(now.setMonth(now.getMonth() - 6)).getTime() / 1000);
                break;
            case '1Y':
                from = Math.floor(new Date(now.setFullYear(now.getFullYear() - 1)).getTime() / 1000);
                break;
        }
        
        // Apply the visible range
        chart.timeScale().setVisibleRange({ from, to });
    }

    // --- 6. Alert Functions ---

    /**
     * Saves the alert prices from the form into chrome.storage.
     */
    async function handleSetAlerts() {
        const buyPrice = parseFloat(document.getElementById('alert-buy-price').value) || 0;
        const sellPrice = parseFloat(document.getElementById('alert-sell-price').value) || 0;

        const { cs2Alerts = {} } = await chrome.storage.local.get("cs2Alerts");
        cs2Alerts[marketHashName] = { buy: buyPrice, sell: sellPrice };
        
        await chrome.storage.local.set({ cs2Alerts });
        
        updateAlertsDisplay(buyPrice, sellPrice);
        showMessage("Alerts set!", "success");
        setTimeout(hideMessage, 2000);
    }

    /**
     * Clears alerts for the current item from chrome.storage.
     */
    async function handleClearAlerts() {
        const { cs2Alerts = {} } = await chrome.storage.local.get("cs2Alerts");
        delete cs2Alerts[marketHashName]; // Only delete for this item
        
        await chrome.storage.local.set({ cs2Alerts });

        // Clear UI
        document.getElementById('alert-buy-price').value = '';
        document.getElementById('alert-sell-price').value = '';
        updateAlertsDisplay(0, 0);
        showMessage("Alerts cleared!", "success");
        setTimeout(hideMessage, 2000);
    }

    /**
     * Loads saved alerts from storage and populates the form.
     */
    async function loadAlertsFromStorage() {
        const { cs2Alerts = {} } = await chrome.storage.local.get("cs2Alerts");
        const alerts = cs2Alerts[marketHashName];
        if (alerts) {
            document.getElementById('alert-buy-price').value = alerts.buy || '';
            document.getElementById('alert-sell-price').value = alerts.sell || '';
            updateAlertsDisplay(alerts.buy, alerts.sell);
        }
    }

    /**
     * Updates the "Active Alerts" text based on saved values.
     */
    function updateAlertsDisplay(buyPrice, sellPrice) {
        const display = document.getElementById('active-alerts-display');
        let text = '';
        if (buyPrice > 0) text += `Watching for price to drop to <strong>${buyPrice}</strong>. `;
        if (sellPrice > 0) text += `Watching for price to rise to <strong>${sellPrice}</strong>.`;
        
        display.innerHTML = text ? `Active Alerts: ${text}` : '';
        display.style.display = text ? 'block' : 'none';
    }

    /**
     * Starts the interval loop to check prices.
     */
    function startPriceCheckLoop() {
        if (!itemNameId || !currencyID) {
            console.warn("CS2 Alert: Cannot start price check loop. Missing itemID or currencyID.");
            return;
        }
        checkPrices(); // Check once immediately
        setInterval(checkPrices, priceCheckInterval);
    }

    /**
     * Fetches live order prices and checks against saved alerts.
     */
    async function checkPrices() {
        const { cs2Alerts = {} } = await chrome.storage.local.get("cs2Alerts");
        const alerts = cs2Alerts[marketHashName];
        
        // If no alerts are set for this item, do nothing.
        if (!alerts || (!alerts.buy && !alerts.sell)) {
            return;
        }

        try {
            // Use Steam's live order histogram API
            const url = `https://steamcommunity.com/market/itemordershistogram?country=US&language=english&currency=${currencyID}&item_nameid=${itemNameId}&two_factor=0`;
            const response = await fetch(url);
            if (!response.ok) return;

            const data = await response.json();
            if (!data.success) return;

            // Get the best prices
            // data.sell_order_graph[0][0] = Lowest "Ask" / Lowest Sell Price
            // data.buy_order_graph[0][0]  = Highest "Bid" / Highest Buy Price
            const lowestSellPrice = data.sell_order_graph[0][0];
            const highestBuyPrice = data.buy_order_graph[0][0];
            
            // Check Buy Alert (if lowest sell price drops to our target)
            if (alerts.buy > 0 && lowestSellPrice <= alerts.buy) {
                triggerAlert('Buy', lowestSellPrice);
                alerts.buy = 0; // Clear alert so it doesn't fire again
            }

            // Check Sell Alert (if highest buy price rises to our target)
            if (alerts.sell > 0 && highestBuyPrice >= alerts.sell) {
                triggerAlert('Sell', highestBuyPrice);
                alerts.sell = 0; // Clear alert
            }

            // Re-save the alerts (since we might have cleared one)
            cs2Alerts[marketHashName] = alerts;
            await chrome.storage.local.set({ cs2Alerts });
            updateAlertsDisplay(alerts.buy, alerts.sell); // Update UI to show cleared alert

        } catch (error) {
            console.error("CS2 Alert: Error in price check loop:", error);
        }
    }

    /**
     * Triggers a desktop notification and plays a sound.
     */
    function triggerAlert(type, price) {
        playBeep();
        
        // Use chrome.notifications API (permission granted in manifest.json)
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icon.png', // This MUST match a file in your extension
            title: `Price Alert: ${type.toUpperCase()}!`,
            message: `${marketHashName}\nPrice hit ${price}!`,
            priority: 2
        });
    }

    // --- 7. Helper Utilities ---

    /**
     * Displays a message overlay on the chart.
     */
    function showMessage(text, type = "loading") {
        messageBox.textContent = text;
        messageBox.className = `cs2-message-box ${type}`;
        messageBox.style.display = 'block';
    }

    /**
     * Hides the message overlay.
     */
    function hideMessage() {
        messageBox.style.display = 'none';
    }
    
    /**
     * Plays a simple beep sound using Web Audio API.
     */
    function playBeep() {
        try {
            const context = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = 'sine'; // Simple sound
            oscillator.frequency.setValueAtTime(800, context.currentTime); // 800 Hz
            oscillator.connect(gain);
            gain.connect(context.destination);
            gain.gain.setValueAtTime(0.5, context.currentTime); // Volume
            oscillator.start(context.currentTime);
            oscillator.stop(context.currentTime + 0.2); // Beep for 200ms
        } catch(e) {
            console.error("CS2 Alert: Could not play beep sound.", e);
        }
    }

})();

