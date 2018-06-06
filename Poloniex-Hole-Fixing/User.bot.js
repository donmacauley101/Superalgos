﻿exports.newUserBot = function newUserBot(bot, logger, COMMONS, UTILITIES, BLOB_STORAGE, STATUS_REPORT, POLONIEX_CLIENT_MODULE) {

    const FULL_LOG = true;
    const LOG_FILE_CONTENT = false;

    const GMT_SECONDS = ':00.000 GMT+0000';
    const GMT_MILI_SECONDS = '.000 GMT+0000';

    const MODULE_NAME = "User Bot";

    const EXCHANGE_NAME = "Poloniex";

    const TRADES_FOLDER_NAME = "Trades";

    thisObject = {
        initialize: initialize,
        start: start
    };

    let charlyStorage = BLOB_STORAGE.newBlobStorage(bot, logger);

    let utilities = UTILITIES.newCloudUtilities(bot, logger);
    let poloniexApiClient = POLONIEX_CLIENT_MODULE.newPoloniexAPIClient(global.EXCHANGE_KEYS[global.EXCHANGE_NAME].Key, global.EXCHANGE_KEYS[global.EXCHANGE_NAME].Secret);
    
    let statusReportModule = STATUS_REPORT.newStatusReport(bot, logger, BLOB_STORAGE, UTILITIES);

    let year;
    let month;

    let statusDependencies;

    return thisObject;

    function initialize(pStatusDependencies, pMonth, pYear, callBackFunction) {

        try {

            year = pYear;
            month = pMonth;
            month = utilities.pad(month, 2); // Adding a left zero when needed.
            statusDependencies = pStatusDependencies;

            logger.fileName = MODULE_NAME + "-" + year + "-" + month;
            logger.initialize();

            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] initialize -> Entering function."); }
            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] initialize -> pYear = " + year); }
            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] initialize -> pMonth = " + month); }

            /* The very first validation is about if we are not too far in the future. In those cases we will not proceed and expect this instance to be restarted later. */

            let processDate = new Date(year + "-" + month + "-1 00:00:00.000 GMT+0000");
            let today = new Date();
            let tomorrow = new Date(today.valueOf() + 1000 * 60 * 60 * 24);

            if (processDate.valueOf() > tomorrow.valueOf()) { // This means that it should start more than a day from current time.
                logger.write(MODULE_NAME, "[WARN] initialize -> Too far in the future.");

                let customOK = {
                    result: global.CUSTOM_OK_RESPONSE.result,
                    message: "Too far in the future."
                }
                logger.write(MODULE_NAME, "[WARN] initialize -> customOK = " + customOK.message);
                callBackFunction(customOK);
                return;
            }

            if (processDate.valueOf() > today.valueOf()) { // This means that is should start in less than a day from current time.
                logger.write(MODULE_NAME, "[WARN] initialize -> Too far in the future.");

                let customOK = {
                    result: global.CUSTOM_OK_RESPONSE.result,
                    message: "Not needed now, but soon."
                }
                logger.write(MODULE_NAME, "[WARN] initialize -> customOK = " + customOK.message);
                callBackFunction(customOK);
                return;
            }

            charlyStorage.initialize(bot.devTeam, onCharlyInizialized);

            function onCharlyInizialized(err) {

                if (err.result === global.DEFAULT_OK_RESPONSE.result) {

                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] initialize -> onCharlyInizialized -> Initialization Succeed."); }
                    callBackFunction(global.DEFAULT_OK_RESPONSE);

                } else {
                    logger.write(MODULE_NAME, "[ERROR] initialize -> onCharlyInizialized -> err = " + err.message);
                    callBackFunction(err);
                }
            }

        } catch (err) {
            logger.write(MODULE_NAME, "[ERROR] initialize -> err = " + err.message);
            callBackFunction(global.DEFAULT_FAIL_RESPONSE);
        }
    }

/*

This process is going to do the following:

It will try to find "holes" on the transaction history and fix them by retrieving the missing transactions from the exchange.

What are holes?

    Holes are missing transactions in the history of the market and the reason there can be holes are the following:

    1) The "Lives Trades" process can be stopped and later started again. The process will only retrieve live trades, leaving a "hole" between it was stopped and restarted.
    2) The "Historic Trades" process might have received a "hole" of transactions directly from the exchange.
    3) The "Historic Trades" process failed to write some files to the storage and now they are missing, together with the transaction in them.
    4) The "Historic Trades" process wrote some files to the storage with corrupted content.
    5) The "Historic Trades" process wrote files with transaction not properly ordered by Trade Id (sometimes the exchange sent this wrong).

How does the process work?

    Transactions have a unique id generated by the exchange. It is a secuencial number. This process scans the transaction history looking for missing ids. When it finds
    some group of missing ids, it request the exchange the missing records and it writes the necesary files to fix the hole. But some things might happen:

    1) The exchange responds, but does not provides the missing records. In this case the process will flag this hole for retry later, up to 3 times. After that it will flag
    the hole as "permanent".
    2) The exchange call timeouts: the process will continue retrying later.
    3) The exchange returns an unexpected error: The process will retry up to 3 times later under this condition.
    4) The exchange returns neighboring transactions but not the missing ones. The process will retry 3 more times and mark the hole as permanent if the exchange refuses to send the missing trades.

Since the process is run in an infinite loop but can be restarted any time, the status of its running is recorded in the Status Report file.

What is the lastFile pointer?

    It is the Datetime since the begining of the hitory of a market that is considered without holes (or only with permanent ones, unfixables). In other words, the process
    starts from the begining of the history of a market, and only when its history is signaled as "Complete" by the "Historic Trades" process. From there, the process is advancing
    in time, validating the history and fixing holes, and moving the lastFile pointer forward as it gets sure that all the previous trades files are with no holes or unfixable ones.
    This pointer will later be used by Indicators bots that depends of these trades, and it will be considered the head of the market.

*/

    function start(callBackFunction) {

        try {

            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> Entering function."); }

            let processDate = new Date(year + "-" + month + "-1 00:00:00.000 GMT+0000");
            let lastMinuteOfMonth = new Date(year + "-" + month + "-1 00:00:00.000 GMT+0000");

            lastMinuteOfMonth.setUTCMonth(lastMinuteOfMonth.getUTCMonth() + 1);             // First we go 1 month into the future.
            lastMinuteOfMonth.setUTCSeconds(lastMinuteOfMonth.getUTCSeconds() - 30);        // Then we go back 30 seconds, or to the last minute of the original month.

            let nextIntervalExecution = false; // This tell weather the Interval module will be executed again or not. By default it will not unless some hole have been found in the current execution.

            let currentDate;                    // This will hold the current datetime of each execution.

            let market = global.MARKET;

            let dateForPath;
            let filePath;
            let exchangeCallTime;

            const MAX_EXCHANGE_CALL_RETRIES = 3;
            const MAX_HOLE_FIXING_RETRIES = 3;
            const FIRST_TRADE_RECORD_ID = -1;
            const UNKNOWN_TRADE_RECORD_ID = -2;

            let exchangeCallRetries = 0;

            let tradesWithHole = [];            // File content of the file where a hole was discovered.

            let currentTradeId;                 // This points to the last Trade Id that is ok.
            let currentDatetime;                // This points to the last Trade datetime that is ok.

            /* The next 3 variables hold the information read from varios Status Reports. */

            let lastLiveTradeFile;              // Datetime of the last complete trades file written by the Live Trades process.
            let lastHistoricTradeFile;          // Datatime of the last trades file written by the Historic Trades process.
            let lastHoleFixingFile;             // Datetime of the last file certified by the Hole Fixing process as without permanent holes.

            /* The next 4 variables hold the results of the search of the next hole. */

            let holeInitialId;                  // This is the Id just before the hole.
            let holeInitialDatetime;            // This is the Datetime just before the hole.

            let holeFinalId;                    // This is the Id just after the hole.
            let holeFinalDatetime;              // This is the Datetime just after the hole.

            let holeFixingStatusReport;         // Current hole Fixing Status Report.

            getContextVariables();

            function getContextVariables() {

                try {

                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> getContextVariables -> Entering function."); }

                    let thisReport;
                    let reportKey;

                    reportKey = "AAMasters" + "-" + "AACharly" + "-" + "Poloniex-Live-Trades" + "-" + "dataSet.V1";
                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> getContextVariables -> reportKey = " + reportKey); }

                    if (statusDependencies.statusReports.get(reportKey).status === "Status Report is corrupt.") {
                        logger.write(MODULE_NAME, "[ERROR] start -> getContextVariables -> Can not continue because dependecy Status Report is corrupt. ");
                        callBackFunction(global.DEFAULT_RETRY_RESPONSE);
                        return;
                    }

                    thisReport = statusDependencies.statusReports.get(reportKey).file;

                    if (thisReport.lastFile === undefined) {
                        logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> Undefined Last File. -> reportKey = " + reportKey);

                        let customOK = {
                            result: global.CUSTOM_OK_RESPONSE.result,
                            message: "Dependency does not exist."
                        }
                        logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> customOK = " + customOK.message);
                        callBackFunction(customOK);
                        return;
                    }

                    lastLiveTradeFile = new Date(thisReport.lastFile.year + "-" + thisReport.lastFile.month + "-" + thisReport.lastFile.days + " " + thisReport.lastFile.hours + ":" + thisReport.lastFile.minutes + GMT_SECONDS);

                    reportKey = "AAMasters" + "-" + "AACharly" + "-" + "Poloniex-Historic-Trades" + "-" + "dataSet.V1";
                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> getContextVariables -> reportKey = " + reportKey); }

                    if (statusDependencies.statusReports.get(reportKey).status === "Status Report is corrupt.") {
                        logger.write(MODULE_NAME, "[ERROR] start -> getContextVariables -> Can not continue because dependecy Status Report is corrupt. ");
                        callBackFunction(global.DEFAULT_RETRY_RESPONSE);
                        return;
                    }

                    thisReport = statusDependencies.statusReports.get(reportKey).file;

                    if (thisReport.lastFile === undefined) {
                        logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> Undefined Last File. -> reportKey = " + reportKey);
                        logger.write(MODULE_NAME, "[HINT] start -> getContextVariables -> It is too early too run this process since the trade history of the market is not there yet.");

                        let customOK = {
                            result: global.CUSTOM_OK_RESPONSE.result,
                            message: "Dependency does not exist."
                        }
                        logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> customOK = " + customOK.message);
                        callBackFunction(customOK);
                        return;
                    }

                    if (thisReport.completeHistory === true) {  // We get from the file to know if this markets history is complete or not. 

                        lastHistoricTradeFile = new Date(thisReport.lastFile.year + "-" + thisReport.lastFile.month + "-" + thisReport.lastFile.days + " " + thisReport.lastFile.hours + ":" + thisReport.lastFile.minutes + GMT_SECONDS);

                        /* Before processing this month we need to check if it is not too far in the past.*/

                        if (
                            processDate.getUTCFullYear() < lastHistoricTradeFile.getUTCFullYear()
                            ||
                            (processDate.getUTCFullYear() === lastHistoricTradeFile.getUTCFullYear() && processDate.getUTCMonth() < lastHistoricTradeFile.getUTCMonth())
                        ) {
                            logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> The current year / month is before the start of the market history for market.");
                            let customOK = {
                                result: global.CUSTOM_OK_RESPONSE.result,
                                message: "Month before it is needed."
                            }
                            logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> customOK = " + customOK.message);
                            callBackFunction(customOK);
                            return;
                        } 

                    } else {
                        logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> Trade History is not complete.");

                        let customOK = {
                            result: global.CUSTOM_OK_RESPONSE.result,
                            message: "Dependency not ready."
                        }
                        logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> customOK = " + customOK.message);
                        callBackFunction(customOK);
                        return;
                    }
                    
                    reportKey = "AAMasters" + "-" + "AACharly" + "-" + "Poloniex-Hole-Fixing" + "-" + "dataSet.V1" + "-" + year + "-" + month;
                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> getContextVariables -> reportKey = " + reportKey); }

                    if (statusDependencies.statusReports.get(reportKey).status === "Status Report is corrupt.") {
                        logger.write(MODULE_NAME, "[ERROR] start -> getContextVariables -> Can not continue because self dependecy Status Report is corrupt. Aborting Process.");
                        callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                        return;
                    }

                    holeFixingStatusReport = statusDependencies.statusReports.get(reportKey).file;

                    if (holeFixingStatusReport.lastFile === undefined) {

                        /* 

                        The file does not exist, so this means this is the first time we are running this process.
                        Then, we might me under two different possible situations:

                        1. We are at the first month of the market. In this case, the starting date is not the begining of the month but the first date of
                           the history of the market.

                        2. We are at some other month different than the first one. In this case, the starting date is the first minute of the market.

                        */

                        if (processDate.valueOf() < lastHistoricTradeFile.valueOf()) {

                            lastHoleFixingFile = new Date(lastHistoricTradeFile.valueOf() - 60 * 1000); // One minute less that the begining of market history.

                            currentTradeId = FIRST_TRADE_RECORD_ID;
                            currentDatetime = new Date(lastHistoricTradeFile.valueOf());

                        } else {

                            lastHoleFixingFile = new Date(processDate.valueOf() - 60 * 1000); // One minute less that the begining of the month.

                            currentTradeId = UNKNOWN_TRADE_RECORD_ID;
                            currentDatetime = new Date(processDate.valueOf());

                        }

                        findNextHole();

                    } else {

                        if (holeFixingStatusReport.monthChecked === true) {

                            logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> The current year / month was already fully checked for market.");

                            let customOK = {
                                result: global.CUSTOM_OK_RESPONSE.result,
                                message: "Month fully processed."
                            }
                            logger.write(MODULE_NAME, "[WARN] start -> getContextVariables -> customOK = " + customOK.message);
                            callBackFunction(customOK);
                            return;

                        } else {

                            /* We get from the file the datetime of the last file without holes. */

                            lastHoleFixingFile = new Date(holeFixingStatusReport.lastFile.year + "-" + holeFixingStatusReport.lastFile.month + "-" + holeFixingStatusReport.lastFile.days + " " + holeFixingStatusReport.lastFile.hours + ":" + holeFixingStatusReport.lastFile.minutes + GMT_SECONDS);

                            currentTradeId = holeFixingStatusReport.lastTrade.id;
                            currentDatetime = new Date(holeFixingStatusReport.lastTrade.year + "-" + holeFixingStatusReport.lastTrade.month + "-" + holeFixingStatusReport.lastTrade.days + " " + holeFixingStatusReport.lastTrade.hours + ":" + holeFixingStatusReport.lastTrade.minutes + ":" + holeFixingStatusReport.lastTrade.seconds + GMT_MILI_SECONDS);

                            findNextHole();
                        }
                    }
                } catch (err) {
                    logger.write(MODULE_NAME, "[ERROR] start -> getContextVariables -> err = " + err.message);
                    if (err.message === "Cannot read property 'file' of undefined") {
                        logger.write(MODULE_NAME, "[HINT] start -> getContextVariables -> Check the bot configuration to see if all of its statusDependencies declarations are correct. ");
                        logger.write(MODULE_NAME, "[HINT] start -> getContextVariables -> Dependencies loaded -> keys = " + JSON.stringify(statusDependencies.keys));
                    }
                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                }
            }

            function findNextHole() {

                try {

                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> Entering function."); }

                    /*

                    To find the next hole, we will read first the current file (which we know if fully ok) and get from it the current Trade Id.
                    After that, we will continue reading the next files, checking all the ids, until we find a hole.

                    */

                    let filePath;
                    let fileName = '' + market.assetA + '_' + market.assetB + '.json';
                    let date;               // This is pointing to each Trades File

                    let fileCheckedCounter = 0;

                    date = new Date(lastHoleFixingFile.valueOf()); 

                    readNextFile();

                    function readNextFile() {

                        try {

                            date = new Date(date.valueOf() + 60 * 1000);

                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> Entering function."); }
                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> date = " + date.toUTCString()); }

                            if (date.valueOf() > lastLiveTradeFile.valueOf()) {

                                /* This mean we reached the forward end of the market */

                                if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> Head of the market reached at date = " + date.toUTCString()); }
                                if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> lastLiveTradeFile = " + lastLiveTradeFile.toUTCString()); }

                                writeStatusReport(currentDatetime, currentTradeId, false, true, onStatusReportWritten);

                                function onStatusReportWritten(err) {

                                    try {
                                        if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> onStatusReportWritten -> Entering function."); }

                                        if (err.result !== global.DEFAULT_OK_RESPONSE.result) {
                                            logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> readNextFile -> onStatusReportWritten -> err = " + err.message);
                                            callBackFunction(err);
                                            return;
                                        }

                                        callBackFunction(global.DEFAULT_OK_RESPONSE);
                                        return;
                                    } catch (err) {
                                        logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> readNextFile -> onStatusReportWritten -> err = " + err.message);
                                        callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                                        return;
                                    }
                                }
                                return;
                            }

                            /* Lets check if we have reached the end of the month. */ 

                            if (date.valueOf() > lastMinuteOfMonth.valueOf()) {

                                if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> End of the month reached at date = " + date.toUTCString()); }

                                writeStatusReport(currentDatetime, currentTradeId, true, false, onStatusReportWritten);

                                function onStatusReportWritten(err) {

                                    try {
                                        if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> onStatusReportWritten -> Entering function."); }

                                        if (err.result !== global.DEFAULT_OK_RESPONSE.result) {
                                            logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> readNextFile -> onStatusReportWritten -> err = " + err.message);
                                            callBackFunction(err);
                                            return;
                                        }

                                        let customOK = {
                                            result: global.CUSTOM_OK_RESPONSE.result,
                                            message: "End of the month reached."
                                        }
                                        logger.write(MODULE_NAME, "[WARN] start -> findNextHole -> readNextFile -> onStatusReportWritten -> customOK = " + customOK.message);
                                        callBackFunction(customOK);

                                        return;
                                    } catch (err) {
                                        logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> readNextFile -> onStatusReportWritten -> err = " + err.message);
                                        callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                                        return;
                                    }
                                }
                                return;
                            }

                            dateForPath = date.getUTCFullYear() + '/' + utilities.pad(date.getUTCMonth() + 1, 2) + '/' + utilities.pad(date.getUTCDate(), 2) + '/' + utilities.pad(date.getUTCHours(), 2) + '/' + utilities.pad(date.getUTCMinutes(), 2);
                            
                            filePath = bot.filePathRoot + "/Output/" + TRADES_FOLDER_NAME + '/' + dateForPath;

                            charlyStorage.getTextFile(filePath, fileName, onNextFileReceived, true);

                            function onNextFileReceived(err, text) {

                                try {

                                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> onNextFileReceived -> Entering function."); }

                                    if (err.result === global.DEFAULT_FAIL_RESPONSE.result) {
                                        logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> readNextFile -> onNextFileReceived -> err = " + err.message);
                                        callBackFunction(err);
                                        return;
                                    }

                                    if (
                                        err.result === global.CUSTOM_FAIL_RESPONSE.result &&
                                        (err.message === 'Folder does not exist.' || err.message === 'File does not exist.')
                                    ) {
                                        logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> onNextFileReceived -> err = " + err.message);

                                        /* The file does not exist, so this means there is a hole!!!  */

                                        if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> onNextFileReceived -> onNextFileReceived -> Hole by missing file detected. Date = " + date.toUTCString()); }

                                        holeInitialId = currentTradeId;
                                        holeInitialDatetime = new Date(currentDatetime.valueOf());  // Field #5 contains the seconds.

                                        findEndOfHole();
                                        return;
                                    } 

                                    if (err.result === global.DEFAULT_OK_RESPONSE.result) {
                                        try {

                                            let tradesTest = JSON.parse(text);

                                        } catch (err) {

                                            /* If the file is corrupt, then we are in a similar situation as if it does not exist. */

                                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> readNextFile -> onNextFileReceived -> onNextFileReceived -> Hole by corrupt file detected. Date = " + date.toUTCString()); }

                                            holeInitialId = currentTradeId;
                                            holeInitialDatetime = new Date(currentDatetime.valueOf());  // Field #5 contains the seconds.

                                            findEndOfHole();
                                            return;
                                        }
                                        checkHolesInFile(text);
                                        return;
                                    }

                                    logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> readNextFile -> onNextFileReceived -> onNextFileReceived -> Unhandled response received. err = " + err.message);
                                    callBackFunction(err);
                                    return;

                                } catch (err) {
                                    logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> readNextFile -> onNextFileReceived -> err = " + err.message);
                                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                                    return;
                                }
                            }

                        } catch (err) {
                            logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> readNextFile -> err = " + err.message);
                            callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                            return;
                        }
                    }

                    function checkHolesInFile(text) {

                        try {

                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> checkHolesInFile -> Entering function."); }

                            let trades = JSON.parse(text);

                            /*
                            tradesWithHole variable:

                            Until verified, this trades in this file becomes potentially the last set of trades with hole. If it is not, then this variable will be overwritten later
                            by the one.

                            We will need these trades at the end of the process.
                            */

                            tradesWithHole = trades; 

                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> checkHolesInFile -> Checking File '" + fileName + "' @ " + filePath + " - " + trades.length + " records in it."); }

                            if (currentTradeId === FIRST_TRADE_RECORD_ID || currentTradeId === UNKNOWN_TRADE_RECORD_ID) { 

                                /*
                                Here we dont know the currentTradeId, so we might take it directly from the file. There will be a problem though if the market starts
                                with some empty files. In those cases, we need to jump to the next file until we find one with some records.
                                */

                                if (trades.length > 0) {

                                    currentTradeId = trades[0][0] - 1;

                                } else {

                                    readNextFile();
                                    return;
                                }
                            }

                            for (let i = 0; i < trades.length; i++) {

                                let fileTradeId = trades[i][0]; // First position in each record.

                                if (currentTradeId + 1 > fileTradeId) {

                                    /*
                                    This happens when the process resumes execution, reads the first file and the first trades have lowers ids that the ones the process already
                                    checked during the last execution.

                                    It also happens when we find a non valid id, as the one used in an empty record signaling that the file is incomplete. (zero).
                                    */
                                    continue; // we simply jump to the next trade.
                                }

                                if (currentTradeId + 1 < fileTradeId) {

                                    /*
                                    We should usually try to fix the hole, but there is an exception. If the we tried this 3 times already, we must declare the problem
                                    unsolvable and move forward. 
                                    */

                                    let lastRecordedTradeId = 0;
                                    let lastRecordedCounter = 0;

                                    if (holeFixingStatusReport !== undefined) { // The whole could have benn found before the monthly report was created.

                                        lastRecordedTradeId = holeFixingStatusReport.lastTrade.id;
                                        lastRecordedCounter = holeFixingStatusReport.lastTrade.counter;
                                    }

                                    if (currentTradeId === lastRecordedTradeId && lastRecordedCounter >= MAX_HOLE_FIXING_RETRIES) {

                                        if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> checkHolesInFile -> Hole by non consecutive ID detected. MAX_HOLE_FIXING_RETRIES reched, giving up with this validation. Date = " + date.toUTCString()); }

                                        /* We advance anyway to the next Id since there is no other solution. */

                                        currentTradeId = fileTradeId;
                                        currentDatetime = new Date(date.valueOf() + trades[i][5] * 1000);

                                    } else {

                                        /* Here we have a hole that needs to be fixed !!! */

                                        if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> checkHolesInFile -> Hole by non consecutive ID detected. Date = " + date.toUTCString()); }

                                        holeInitialId = currentTradeId;
                                        holeInitialDatetime = new Date(currentDatetime.valueOf());

                                        holeFinalId = fileTradeId;
                                        holeFinalDatetime = new Date(date.valueOf() + trades[i][5] * 1000);  // Field #5 contains the seconds.

                                        getTheTrades();

                                        break;
                                    }

                                } else {

                                    /* We keep here the last Trade Id and Datetime that are allright. */

                                    currentTradeId = fileTradeId;
                                    currentDatetime = new Date(date.valueOf() + trades[i][5] * 1000);
                                }
                            }

                            if (holeInitialId === undefined) {

                                fileCheckedCounter++;

                                if (fileCheckedCounter === 60) { // Every hour checked we write a Status Report so that if the process is terminated, it can resume later from there.

                                    writeStatusReport(currentDatetime, currentTradeId, false, false, onStatusReportWritten);

                                    function onStatusReportWritten(err) {

                                        try {
                                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> checkHolesInFile -> onStatusReportWritten -> Entering function."); }

                                            if (err.result !== global.DEFAULT_OK_RESPONSE.result) {
                                                logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> checkHolesInFile -> onStatusReportWritten -> err = " + err.message);
                                                callBackFunction(err);
                                                return;
                                            }

                                            fileCheckedCounter = 0;
                                            readNextFile();

                                            return;
                                        } catch (err) {
                                            logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> checkHolesInFile -> onStatusReportWritten -> err = " + err.message);
                                            callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                                            return;
                                        }
                                    }
                                } else {

                                    readNextFile();
                                }
                            }

                        } catch (err) {
                            logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> checkHolesInFile -> err = " + err.message);
                            callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                            return;
                        }
                    }

                    function findEndOfHole() {

                        try {

                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> findEndOfHole -> Entering function."); }

                            /* Here we will enter a loop where will try to find the next available file recorded and extract from it the Id and Datetime from the first record. */

                            date = new Date(date.valueOf() + 60 * 1000);

                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> findEndOfHole -> Date = " + date.toUTCString()); }

                            if (date.valueOf() > lastLiveTradeFile.valueOf()) {

                                /*
                                In this case we have an open hole produced by a missing file, and because live trades files contains zero records or are missing, we reached the
                                forward side of the market. The situation in unsolvable for now, we will leave it of future execution.
                                */

                                if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> findEndOfHole -> Head of the market reached -> Date = " + date.toUTCString()); }

                                nextIntervalExecution = true; // Even if we didn-t find the end of the hole, we need to continue the execution of this month interval.

                                writeStatusReport(currentDatetime, currentTradeId, false, false, onStatusReportWritten);

                                function onStatusReportWritten(err) {

                                    try {
                                        if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> findEndOfHole -> onStatusReportWritten -> Entering function."); }

                                        if (err.result !== global.DEFAULT_OK_RESPONSE.result) {
                                            logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> findEndOfHole -> onStatusReportWritten -> err = " + err.message);
                                            callBackFunction(err);
                                            return;
                                        }

                                        callBackFunction(global.DEFAULT_OK_RESPONSE); 
                                        return;
                                    } catch (err) {
                                        logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> findEndOfHole -> onStatusReportWritten -> err = " + err.message);
                                        callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                                        return;
                                    }
                                }
                                return;
                            }

                            dateForPath = date.getUTCFullYear() + '/' + utilities.pad(date.getUTCMonth() + 1, 2) + '/' + utilities.pad(date.getUTCDate(), 2) + '/' + utilities.pad(date.getUTCHours(), 2) + '/' + utilities.pad(date.getUTCMinutes(), 2);

                            filePath = bot.filePathRoot + "/Output/" + TRADES_FOLDER_NAME + '/' + dateForPath;

                            charlyStorage.getTextFile(filePath, fileName, onNextFileReceived, true);

                            function onNextFileReceived(err, text) {

                                try {

                                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> findEndOfHole -> onNextFileReceived -> Entering function."); }

                                    if (err.result === global.DEFAULT_FAIL_RESPONSE.result) {
                                        logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> findEndOfHole -> onNextFileReceived -> err = " + err.message);
                                        callBackFunction(err);
                                        return;
                                    }

                                    if (
                                        err.result === global.CUSTOM_FAIL_RESPONSE.result &&
                                        (err.message === 'Folder does not exist.' || err.message === 'File does not exist.')
                                    ) {
                                        logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> findEndOfHole -> onNextFileReceived -> err = " + err.message);

                                        /* The file does not exist, so this means we need to move forward  */

                                        findEndOfHole();
                                        return;
                                    } 

                                    if (err.result === global.DEFAULT_OK_RESPONSE.result)
                                    {
                                        let trades;

                                        try {

                                            trades = JSON.parse(text);

                                        } catch (err) {

                                            /* If the file is corrupt, then we are in a similar situation as if it does not exist. */

                                            logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> findEndOfHole -> onNextFileReceived -> Corrupt file with no records. -> Date = " + date.toUTCString());

                                            findEndOfHole();
                                            return;
                                        } 

                                        if (trades.length === 0) {

                                            /* This is the same situation that if there is no file, move forward */

                                            logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> findEndOfHole -> onNextFileReceived -> File with no records. -> Date = " + date.toUTCString());

                                            findEndOfHole();
                                            return;
                                        }

                                        logger.write(MODULE_NAME, "[INFO] start -> findNextHole -> findEndOfHole -> onNextFileReceived -> Next available record found at date = " + date.toUTCString());

                                        let fileTradeId = trades[0][0]; // First position in each record.

                                        holeFinalId = fileTradeId;
                                        holeFinalDatetime = new Date(date.valueOf() + trades[0][5] * 1000);  // Field #5 contains the seconds.

                                        getTheTrades();
                                        return;
                                    }

                                    logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> findEndOfHole -> onNextFileReceived -> Unhandled response received. err = " + err.message);
                                    callBackFunction(err);
                                    return;

                                } catch (err) {
                                    logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> findEndOfHole -> onNextFileReceived -> err = " + err.message);
                                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                                    return;
                                }
                            }

                        } catch (err) {
                            logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> findEndOfHole -> err = " + err.message);
                            callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                            return;
                        }
                    }

                } catch (err) {
                    logger.write(MODULE_NAME, "[ERROR] start -> findNextHole -> err = " + err.message);
                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                    return;
                }
            }

            function getTheTrades() {

                try {

                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> getTheTrades -> Entering function."); }

                    /*
                    We request to the Exchange API some more records than needed, anyway we will discard records out of the range we need.
                    To do this we substract 120 seconds and add 10 seconds to the already calculated current date.
                    */

                    const startTime = parseInt(holeInitialDatetime.valueOf() / 1000 - 65);
                    const endTime = parseInt(holeFinalDatetime.valueOf() / 1000 + 65);

                    exchangeCallTime = new Date();

                    let poloniexApiClient = POLONIEX_CLIENT_MODULE.newPoloniexAPIClient(global.EXCHANGE_KEYS[global.EXCHANGE_NAME].Key, global.EXCHANGE_KEYS[global.EXCHANGE_NAME].Secret);

                    poloniexApiClient.API.returnPublicTradeHistory(market.assetA, market.assetB, startTime, endTime, onExchangeCallReturned);

                } catch (err) {
                    logger.write(MODULE_NAME, "[ERROR] start -> getTheTrades -> err = " + err.message);
                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                    return;
                }
            }

            function onExchangeCallReturned(err, exchangeResponse) {

                try {

                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> onExchangeCallReturned -> Entering function."); }

                    if (FULL_LOG === true) {

                        let exchangeResponseTime = new Date();
                        let timeDifference = (exchangeResponseTime.valueOf() - exchangeCallTime.valueOf()) / 1000;
                        logger.write(MODULE_NAME, "[INFO] start -> onExchangeCallReturned -> Call time recorded = " + timeDifference + " seconds.");
                    }

                    poloniexApiClient.API.analizeResponse(logger, err, exchangeResponse, callBackFunction, onResponseOk);

                    function onResponseOk() {

                        tradesReadyToBeSaved(exchangeResponse);
                    }

                } catch (err) {
                    logger.write(MODULE_NAME, "[ERROR] start -> onExchangeCallReturned -> err = " + err.message);
                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                    return;
                }
            }

            function tradesReadyToBeSaved(tradesRequested) {

                try {

                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> Entering function."); }

                    /*
                    We have learnt that the records from the exchange dont always come in the right order, sorted by TradeId. That means the we need to sort them
                    by ourselves if we want that our verification of holes work. 
                    */

                    let iterations = tradesRequested.length;

                    for (let i = 0; i < iterations; i++) {

                        for (let j = 0; j < iterations - 1; j++) {

                            if (tradesRequested[j].tradeID < tradesRequested[j + 1].tradeID) {

                                let trade = tradesRequested[j + 1];
                                tradesRequested.splice(j + 1, 1); // Remove that trade from the array.
                                tradesRequested.splice(j, 0, trade); // Insert the trade removed.
                            }
                        }
                    }
                    /*
                    The trades received from the exchange might or might not be enough to fix the hole. We wont worry about that at this point. We will simple record the trades received
                    in the range where records where missing.

                    We only have to take into account that the lowest id we have is already on a file that exist and it is partially verified, so we have to be carefull to overwrite this file
                    without introducing new holes. 
                    */

                    let fileRecordCounter = 0;
                    let needSeparator;
                    let separator;

                    let lastProcessMinute;  // Stores the previous record minute during each iteration
                    let filesToSave = [];   // Array where we will store all the content to be written to files

                    needSeparator = false;

                    let fileContent = "";

                    let currentProcessMinute = Math.trunc(holeFinalDatetime.valueOf() / 1000 / 60); // Number of minutes since the begining of time, where the process is pointing to.
                    let holeStartsMinute = Math.trunc(holeInitialDatetime.valueOf() / 1000 / 60); // Number of minutes since the begining of time, where the hole started.

                    /* We will iterate through all the records received from the exchange. We know Poloniex sends the older records first, so this is going to be going back in time as we advance. */

                    for (let i = 0; i < tradesRequested.length; i++) {

                        let record = tradesRequested[i];

                        const trade = {
                            tradeIdAtExchange: record.tradeID,
                            marketIdAtExchange: record.globalTradeID,
                            type: record.type,
                            rate: record.rate,
                            amountA: record.total,
                            amountB: record.amount,
                            datetime: new Date(record.date + GMT_MILI_SECONDS)
                        };

                        trade.seconds = trade.datetime.getUTCSeconds();

                        let currentRecordMinute = Math.trunc(trade.datetime.valueOf() / 1000 / 60);  // This are the number of minutes since the begining of time of this trade.

                        if (currentRecordMinute > currentProcessMinute) {

                            /* We discard this trade, since it happened after the minute we want to record in the current file. */

                            continue;
                        }

                        if (currentRecordMinute < currentProcessMinute) {

                            /* 
                            The information is older that the current time.
                            We must store the current info and reset the pointer to the current time to match the one on the information currently being processd.
                            We know this can lead to a 'hole' or some empty files being skipped, but we solve that problem with the next loop.
                            */

                            let blackMinutes = currentProcessMinute - currentRecordMinute;

                            for (let j = 1; j <= blackMinutes; j++) {

                                storeFileContent();
                                currentProcessMinute--;
                            }
                        }

                        if (currentRecordMinute === currentProcessMinute) {

                            if (needSeparator === false) {

                                needSeparator = true;
                                separator = '';

                            } else {
                                separator = ',';
                            }

                            if (trade.tradeIdAtExchange > holeInitialId) {

                                /* We only add trades with ids bigger that the last id verified without holes. */

                                fileContent = '[' + trade.tradeIdAtExchange + ',"' + trade.type + '",' + trade.rate + ',' + trade.amountA + ',' + trade.amountB + ',' + trade.seconds + ']' + separator + fileContent;

                                fileRecordCounter++;
                            }
                        }
                    }

                    if (fileContent !== "") {

                        /* 
                        Usually the last file Content must be discarded since it could belong to an incomplete file. But there is one exception: it a hole is found at a file and the previous minute is empty
                        then this will produce the exception in which the fileContent needs to saved. To figure out if we are in this situation we do the following:
                        */

                        if (currentProcessMinute === holeStartsMinute) {

                            storeFileContent();
                        }
                    }

                    function storeFileContent() {

                        try {

                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> storeFileContent -> Entering function."); }

                            let existingFileContent = "";
                            let separator = "";

                            if (currentProcessMinute === holeStartsMinute) {

                                /*
                                Here we are at the situation that the content already generated has to be added to the content already existing on the file where the hole was found.
                                */

                                for (let i = 0; i < tradesWithHole.length; i++) {

                                    if (tradesWithHole[i][0] <= holeInitialId && tradesWithHole[i][0] !== 0) { // 0 because of the empty trade record signaling an incomplete file.

                                        /* We only add trades with ids smallers that the last id verified without holes. */

                                        existingFileContent = existingFileContent + separator + '[' + tradesWithHole[i][0] + ',"' + tradesWithHole[i][1] + '",' + tradesWithHole[i][2] + ',' + tradesWithHole[i][3] + ',' + tradesWithHole[i][4] + ',' + tradesWithHole[i][5] + ']';
                                        fileRecordCounter++;

                                        if (separator === "") {

                                            separator = ",";
                                        }
                                    }
                                }
                            }

                            if (existingFileContent === "") {

                                fileContent = '[' + fileContent + ']';

                            } else {

                                if (fileContent === "") {
                                    fileContent = '[' + existingFileContent + ']';
                                } else {
                                    fileContent = '[' + existingFileContent + "," + fileContent + ']';
                                }
                            }

                            let fileRecord = {
                                datetime: currentProcessMinute,
                                content: fileContent,
                                records: fileRecordCounter
                            };

                            filesToSave.push(fileRecord);

                            fileRecordCounter = 0;
                            needSeparator = false;
                            fileContent = "";

                        } catch (err) {
                            logger.write(MODULE_NAME, "[ERROR] start -> tradesReadyToBeSaved -> storeFileContent -> err = " + err.message);
                            callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                            return;
                        }
                    }

                    /* Now it is time to process all the information we stored at filesToSave. */

                    let i = 0;
                    let date;

                    nextRecord();

                    function nextRecord() {

                        try {

                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> nextRecord -> Entering function."); }

                            let fileName = '' + market.assetA + '_' + market.assetB + '.json';

                            date = new Date(filesToSave[i].datetime * 60 * 1000);
                            fileRecordCounter = filesToSave[i].records;
                            fileContent = filesToSave[i].content;

                            dateForPath = date.getUTCFullYear() + '/' + utilities.pad(date.getUTCMonth() + 1, 2) + '/' + utilities.pad(date.getUTCDate(), 2) + '/' + utilities.pad(date.getUTCHours(), 2) + '/' + utilities.pad(date.getUTCMinutes(), 2);

                            filePath = bot.filePathRoot + "/Output/" + TRADES_FOLDER_NAME + '/' + dateForPath;

                            charlyStorage.createTextFile(filePath, fileName, fileContent + '\n', onFileCreated);

                            function onFileCreated(err) {

                                try {

                                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> nextRecord -> onFileCreated -> Entering function."); }

                                    if (err.result !== global.DEFAULT_OK_RESPONSE.result) {
                                        logger.write(MODULE_NAME, "[ERROR] start -> tradesReadyToBeSaved -> nextRecord -> onFileCreated -> err = " + err.message);
                                        callBackFunction(err);
                                        return;
                                    }

                                    if (LOG_FILE_CONTENT === true) {
                                        logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> nextRecord -> onFileCreated -> Content written = " + fileContent);
                                    }

                                    logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> nextRecord -> onFileCreated -> Finished with File @ " + market.assetA + "_" + market.assetB); 
                                    logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> nextRecord -> onFileCreated -> Records inserted = " + fileRecordCounter); 
                                    logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> nextRecord -> onFileCreated -> Path = " + filePath + "/" + fileName + ""); 

                                    controlLoop();

                                } catch (err) {
                                    logger.write(MODULE_NAME, "[ERROR] start -> tradesReadyToBeSaved -> nextRecord -> onFileCreated -> err = " + err.message);
                                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                                    return;
                                }
                            }

                        } catch (err) {
                            logger.write(MODULE_NAME, "[ERROR] start -> tradesReadyToBeSaved -> nextRecord -> err = " + err.message);
                            callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                            return;
                        }
                    }

                    function controlLoop() {

                        try {

                            if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> controlLoop -> Entering function."); }

                            i++;

                            if (i < filesToSave.length) {

                                nextRecord();

                            } else {

                                if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> controlLoop -> Leaving function 'tradesReadyToBeSaved'."); }

                                writeStatusReport(undefined, undefined, false, false, onStatusReportWritten);

                                function onStatusReportWritten() {

                                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> tradesReadyToBeSaved -> controlLoop -> onStatusReportWritten -> Entering function."); }

                                    callBackFunction(global.DEFAULT_OK_RESPONSE);
                                    return;
                                }
                            }

                        } catch (err) {
                            logger.write(MODULE_NAME, "[ERROR] start -> tradesReadyToBeSaved -> controlLoop -> err = " + err.message);
                            callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                            return;
                        }
                    }
                }
                catch (err) {
                    logger.write(MODULE_NAME, "[ERROR] start -> tradesReadyToBeSaved -> err = " + err.message);
                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                    return;
                }
            }

            function writeStatusReport(lastTradeDatetime, lastTradeId, monthChecked, atHeadOfMarket, callBack) {

                try {

                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> writeStatusReport -> Entering function."); }

                    /*
                    If no parameters are provided, that means that last good information is the begining of the hole. If they are provided is because no hole was detected until the
                    forward end of the market.
                    */

                    let key = bot.devTeam + "-" + bot.codeName + "-" + bot.process + "-" + bot.dataSetVersion + "-" + year + "-" + month;
                    let statusReport = statusDependencies.statusReports.get(key);

                    if (lastTradeId === undefined) {

                        lastTradeId = holeInitialId;
                        lastTradeDatetime = holeInitialDatetime;
                    }

                    let lastFileWithoutHoles = new Date(lastTradeDatetime.valueOf() - 60 * 1000); // It is the previous file where the last verified trade is.

                    /*
                    Here we will calculate the "counter". The counter keeps track of how many times the process tried to fix the same hole. This allows
                    the process to know when a hole is not fixable. To do that we need to compare the current status report with the information we ve got
                    about the hole. If it is the same, we add to the counter.
                    */

                    let counter = 0;

                    try {

                        if (holeFixingStatusReport.lastTrade.id === lastTradeId) {

                            counter = holeFixingStatusReport.lastTrade.counter;

                            if (counter === undefined) { counter = 0; }
                            counter++;
                        }

                    } catch (err) { // we are here when the status report did not exist.
                        counter = 0;
                    }

                    statusReport.file = {
                        lastFile: {
                            year: lastFileWithoutHoles.getUTCFullYear(),
                            month: (lastFileWithoutHoles.getUTCMonth() + 1),
                            days: lastFileWithoutHoles.getUTCDate(),
                            hours: lastFileWithoutHoles.getUTCHours(),
                            minutes: lastFileWithoutHoles.getUTCMinutes()
                        },
                        lastTrade: {
                            year: lastTradeDatetime.getUTCFullYear(),
                            month: (lastTradeDatetime.getUTCMonth() + 1),
                            days: lastTradeDatetime.getUTCDate(),
                            hours: lastTradeDatetime.getUTCHours(),
                            minutes: lastTradeDatetime.getUTCMinutes(),
                            seconds: lastTradeDatetime.getUTCSeconds(),
                            id: lastTradeId,
                            counter: counter
                        },
                        monthChecked: monthChecked,
                        atHeadOfMarket: atHeadOfMarket
                    };

                    statusReport.save(onSaved);

                    function onSaved(err) {

                        if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> writeStatusReport -> onSaved -> Entering function."); }

                        if (err.result !== global.DEFAULT_OK_RESPONSE.result) {
                            logger.write(MODULE_NAME, "[ERROR] start -> writeStatusReport -> onSaved -> err = " + err.message);
                            callBackFunction(err);
                            return;
                        }

                        /* 
                        If we are at the same month of the begining of the market, we need to create the main status report file.
                        We will re-create it even every time the month status report is created. When this month check finished, other months later
                        will update it.
                        */

                        if (processDate.getUTCMonth() === lastHistoricTradeFile.getUTCMonth() && processDate.getUTCFullYear() === lastHistoricTradeFile.getUTCFullYear()) {

                            createMainStatusReport(lastTradeDatetime, lastTradeId, onMainReportCreated);

                            function onMainReportCreated() {

                                if (monthChecked === true) {

                                    let key = bot.devTeam + "-" + bot.codeName + "-" + bot.process + "-" + bot.dataSetVersion;
                                    let statusReport = statusDependencies.statusReports.get(key);
                                    statusReport.verifyMarketComplete(callBack);
                                    return;

                                } else {
                                    callBack(global.DEFAULT_OK_RESPONSE);
                                    return;
                                }
                            }

                        } else {

                            if (monthChecked === true) {

                                let key = bot.devTeam + "-" + bot.codeName + "-" + bot.process + "-" + bot.dataSetVersion;
                                let statusReport = statusDependencies.statusReports.get(key);
                                statusReport.verifyMarketComplete(callBack);
                                return;

                            } else {
                                callBack(global.DEFAULT_OK_RESPONSE);
                                return;
                            }
                        }
                    }

                } catch (err) {
                    logger.write(MODULE_NAME, "[ERROR] start -> writeStatusReport -> err = " + err.message);
                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                    return;
                }
            }

            function createMainStatusReport(lastTradeDatetime, lastTradeId, callBack) {

                try {
                    if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> createMainStatusReport -> Entering function."); }

                    let key = bot.devTeam + "-" + bot.codeName + "-" + bot.process + "-" + bot.dataSetVersion;

                    let statusReport = statusDependencies.statusReports.get(key);

                    let lastFileWithoutHoles = new Date(lastTradeDatetime.valueOf() - 60 * 1000); // It is the previous file where the last verified trade is.

                    statusReport.file = {
                        lastFile: {
                            year: lastFileWithoutHoles.getUTCFullYear(),
                            month: (lastFileWithoutHoles.getUTCMonth() + 1),
                            days: lastFileWithoutHoles.getUTCDate(),
                            hours: lastFileWithoutHoles.getUTCHours(),
                            minutes: lastFileWithoutHoles.getUTCMinutes()
                        },
                        lastTrade: {
                            year: lastTradeDatetime.getUTCFullYear(),
                            month: (lastTradeDatetime.getUTCMonth() + 1),
                            days: lastTradeDatetime.getUTCDate(),
                            hours: lastTradeDatetime.getUTCHours(),
                            minutes: lastTradeDatetime.getUTCMinutes(),
                            seconds: lastTradeDatetime.getUTCSeconds(),
                            id: lastTradeId
                        }
                    };

                    statusReport.save(onSaved);

                    function onSaved(err) {

                        if (FULL_LOG === true) { logger.write(MODULE_NAME, "[INFO] start -> createMainStatusReport -> onSaved -> Entering function."); }

                        if (err.result !== global.DEFAULT_OK_RESPONSE.result) {
                            logger.write(MODULE_NAME, "[ERROR] start -> createMainStatusReport -> onSaved -> err = " + err.message);
                            callBackFunction(err);
                            return;
                        }

                        callBack(global.DEFAULT_OK_RESPONSE);
                        return;
                    }
                }
                catch (err) {
                    logger.write(MODULE_NAME, "[ERROR] start -> createMainStatusReport -> err = " + err.message);
                    callBackFunction(global.DEFAULT_FAIL_RESPONSE);
                    return;
                }
            }

        } catch (err) {
            logger.write(MODULE_NAME, "[ERROR] start -> err = " + err.message);
            callBackFunction(global.DEFAULT_FAIL_RESPONSE);
            return;
        }
    }
};
