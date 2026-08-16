// Logger.js - 统一日志管理模块

const PREFIX = '%c[收藏器]';
const BASE_STYLE = 'font-weight: bold; padding: 2px 4px; border-radius: 3px; margin-right: 4px;';

// 控制台输出样式（不同级别不同背景色）
const CONSOLE_STYLES = {
    info: `${BASE_STYLE} color: rgba(255, 255, 255, 1); background-color: rgba(23, 162, 184, 1);`,
    success: `${BASE_STYLE} color: rgba(255, 255, 255, 1); background-color: rgba(40, 167, 69, 1);`,
    warn: `${BASE_STYLE} color: rgba(51, 51, 51, 1); background-color: rgba(255, 193, 7, 1);`,
    error: `${BASE_STYLE} color: rgba(255, 255, 255, 1); background-color: rgba(220, 53, 69, 1);`,
    debug: `${BASE_STYLE} color: rgba(108, 117, 125, 1); background-color: rgba(248, 249, 250, 1); border: 1px solid rgba(222, 226, 230, 1);`
};

export const LogLevel = {
    NONE: 0,
    CORE: 1,
    RUNTIME: 2,
    FULL: 3
};

class Logger {
    static currentLevel = LogLevel.RUNTIME;
    static logHistory = [];

    static pushToHistory(levelName, ...args) {
        // 时间戳只保留 HH:MM:SS，去掉年月日前缀
        const now = new Date();
        const timestamp = String(now.getHours()).padStart(2, '0') + ':' +
                          String(now.getMinutes()).padStart(2, '0') + ':' +
                          String(now.getSeconds()).padStart(2, '0');
        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, (key, value) => {
                        if (key === 'parent' || key === 'dom' || key === 'collection') return '[已省略嵌套对象]';
                        return value;
                    });
                } catch (e) { return '[复杂对象/解析失败]'; }
            }
            return String(arg);
        }).join(' ');

        this.logHistory.push(`[${timestamp}] [${levelName}] ${message}`);
        if (this.logHistory.length > 500) this.logHistory.shift();
    }

    static getLogText() {
        return this.logHistory.join('\n');
    }

    static clearHistory() {
        this.logHistory = [];
    }

    static exportLogs() {
        if (this.logHistory.length === 0) return false;
        const blob = new Blob([this.logHistory.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `StarPlugin_DebugLog_${new Date().getTime()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return true;
    }

    static setLogLevel(level) {
        if (level in LogLevel) this.currentLevel = LogLevel[level];
        else if (typeof level === 'number' && level >= 0 && level <= 3) this.currentLevel = level;
    }

    static shouldLog(level) { return this.currentLevel >= level; }

    static error(...args) {
        this.pushToHistory('ERROR', ...args);
        if (this.shouldLog(LogLevel.CORE)) console.error(PREFIX, CONSOLE_STYLES.error, ...args);
    }

    static warn(...args) {
        this.pushToHistory('WARN', ...args);
        if (this.shouldLog(LogLevel.CORE)) console.warn(PREFIX, CONSOLE_STYLES.warn, ...args);
    }

    static info(...args) {
        this.pushToHistory('INFO', ...args);
        if (this.shouldLog(LogLevel.RUNTIME)) console.log(PREFIX, CONSOLE_STYLES.info, ...args);
    }

    static success(...args) {
        this.pushToHistory('SUCCESS', ...args);
        if (this.shouldLog(LogLevel.RUNTIME)) console.log(PREFIX, CONSOLE_STYLES.success, ...args);
    }

    static debug(...args) {
        this.pushToHistory('DEBUG', ...args);
        if (this.shouldLog(LogLevel.FULL)) console.debug(PREFIX, CONSOLE_STYLES.debug, ...args);
    }
}

export default Logger;
