"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS = exports.SETTING_ENV_MAP = void 0;
exports.applyEnvOverrides = applyEnvOverrides;
exports.getSettingMetadata = getSettingMetadata;
exports.validateSettings = validateSettings;
exports.mergeWithDefaults = mergeWithDefaults;
exports.validateSettingsLenient = validateSettingsLenient;
// Maps each persisted setting to its environment-variable override (if any) and
// whether changing it is applied dynamically or requires a restart.
exports.SETTING_ENV_MAP = {
    logDir: { envVar: "LOGGER_CAPTURE_DIR", dynamic: false },
    maxSessions: { envVar: "LOGGER_MAX_SESSIONS", dynamic: false },
    redactPreset: { envVar: "REDACT_PRESET", dynamic: true },
    redactReversible: { envVar: "REDACT_REVERSIBLE", dynamic: true },
    redactPolicyFile: { envVar: "REDACT_POLICY_FILE", dynamic: true },
    encryptionAtRest: {
        envVar: "CONTEXTIO_LOGGER_ENCRYPTION_ENABLED",
        dynamic: false,
    },
    captureCleanupEnabled: {
        envVar: "LOGGER_CAPTURE_CLEANUP_ENABLED",
        dynamic: false,
    },
    captureCleanupIntervalHours: {
        envVar: "LOGGER_CAPTURE_CLEANUP_INTERVAL",
        dynamic: false,
    },
    captureCleanupMaxAgeDays: {
        envVar: "LOGGER_CAPTURE_MAX_AGE",
        dynamic: false,
    },
    theme: {
        envVar: "CONTEXTIO_THEME",
        dynamic: true,
    },
    oidcEnabled: {
        envVar: "CONTEXTIO_OIDC_ENABLED",
        dynamic: false,
    },
    oidcPublicUrl: {
        envVar: "CONTEXTIO_OIDC_PUBLIC_URL",
        dynamic: false,
    },
    showPageLoadTime: {
        envVar: "", // No env var override - controlled via settings UI only
        dynamic: true,
    },
    detectorMode: {
        envVar: "REDACT_DETECTOR_MODE",
        dynamic: true,
    },
    detectorModelDir: {
        envVar: "REDACT_DETECTOR_MODEL_DIR",
        dynamic: true,
    },
    detectorThreshold: {
        envVar: "REDACT_DETECTOR_THRESHOLD",
        dynamic: true,
    },
    rateLimiter: {
        envVar: "", // No direct env var - configured via settings file/UI with per-provider keys
        dynamic: false,
    },
    streamingRetry: {
        envVar: "", // No direct env var - configured via settings file/UI with per-provider keys
        dynamic: false,
    },
};
/**
 * Override settings values with corresponding environment variables where defined.
 * Returns a new Settings object with env var values applied, together with the set
 * of keys whose env values were successfully applied. Treats numeric env vars as
 * their raw unit (hours / days) to stay consistent with the proxy config; string
 * and boolean fields are passed through directly.
 */
function strictInteger(raw) {
    return /^\d+$/.test(raw);
}
function applyEnvOverrides(settings) {
    var override = {};
    var appliedKeys = new Set();
    Object.entries(exports.SETTING_ENV_MAP).forEach(function (_a) {
        var key = _a[0], envVar = _a[1].envVar;
        var raw = process.env[envVar];
        if (raw === undefined)
            return;
        var accepted = false;
        switch (key) {
            case "logDir":
                override.logDir = raw;
                accepted = true;
                break;
            case "maxSessions": {
                var n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
                if (Number.isFinite(n) && n >= 0 && n <= 10000) {
                    override.maxSessions = n;
                    accepted = true;
                }
                break;
            }
            case "redactPreset":
                if (["secrets", "pii", "strict"].includes(raw)) {
                    override.redactPreset = raw;
                    accepted = true;
                }
                break;
            case "redactReversible":
                if (raw === "true" || raw === "false") {
                    override.redactReversible = raw === "true";
                    accepted = true;
                }
                break;
            case "redactPolicyFile":
                override.redactPolicyFile = raw;
                accepted = true;
                break;
            case "encryptionAtRest":
                if (raw === "true" || raw === "false") {
                    override.encryptionAtRest = raw === "true";
                    accepted = true;
                }
                break;
            case "captureCleanupEnabled":
                if (raw === "true" || raw === "false") {
                    override.captureCleanupEnabled = raw === "true";
                    accepted = true;
                }
                break;
            case "captureCleanupIntervalHours": {
                var n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
                if (Number.isFinite(n) && n >= 1 && n <= 168) {
                    override.captureCleanupIntervalHours = n;
                    accepted = true;
                }
                break;
            }
            case "captureCleanupMaxAgeDays": {
                var n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
                if (Number.isFinite(n) && n >= 1 && n <= 365) {
                    override.captureCleanupMaxAgeDays = n;
                    accepted = true;
                }
                break;
            }
            case "theme":
                if ([
                    "light",
                    "dark",
                    "system",
                    "high-contrast",
                    "material-light",
                    "material-dark",
                    "solarized-light",
                    "solarized-dark",
                    "dracula",
                    "nord",
                    "github-light",
                    "github-dark",
                    "one-dark",
                    "monokai",
                ].includes(raw)) {
                    override.theme = raw;
                    accepted = true;
                }
                break;
            case "oidcEnabled":
                if (raw === "true" || raw === "false") {
                    override.oidcEnabled = raw === "true";
                    accepted = true;
                }
                break;
            case "oidcPublicUrl":
                override.oidcPublicUrl = raw;
                accepted = true;
                break;
            case "detectorMode":
                if (["rules", "llm", "hybrid", "auto"].includes(raw)) {
                    override.detectorMode = raw;
                    accepted = true;
                }
                break;
            case "detectorModelDir":
                override.detectorModelDir = raw;
                accepted = true;
                break;
            case "detectorThreshold": {
                var n = parseFloat(raw);
                if (!isNaN(n) && n >= 0 && n <= 1) {
                    override.detectorThreshold = n;
                    accepted = true;
                }
                break;
            }
            default:
                break;
        }
        if (accepted)
            appliedKeys.add(key);
    });
    return { settings: __assign(__assign({}, settings), override), appliedKeys: appliedKeys };
}
// Computes per-setting metadata: where the active value comes from, which env
// var overrides it, and whether it is applied dynamically.
function getSettingMetadata(settings, appliedEnvKeys) {
    var meta = {};
    Object.keys(exports.SETTING_ENV_MAP).forEach(function (key) {
        var _a = exports.SETTING_ENV_MAP[key], envVar = _a.envVar, dynamic = _a.dynamic;
        var effective = appliedEnvKeys.has(key);
        var source;
        if (effective) {
            source = "environment-variable";
        }
        else if (JSON.stringify(settings[key]) !== JSON.stringify(exports.DEFAULT_SETTINGS[key])) {
            source = "settings-file";
        }
        else {
            source = "default";
        }
        meta[key] = { source: source, envVar: effective ? envVar : null, dynamic: dynamic };
    });
    return meta;
}
exports.DEFAULT_SETTINGS = {
    logDir: "",
    maxSessions: 0,
    redactPreset: "pii",
    redactReversible: false,
    redactPolicyFile: "",
    encryptionAtRest: false,
    captureCleanupEnabled: false,
    captureCleanupIntervalHours: 24,
    captureCleanupMaxAgeDays: 30,
    theme: "system",
    oidcEnabled: false,
    oidcPublicUrl: "",
    showPageLoadTime: false,
    detectorMode: "rules",
    detectorModelDir: "",
    detectorThreshold: 0.5,
    rateLimiter: {
        anthropic: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
        openai: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
        chatgpt: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
        gemini: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
        geminiCodeAssist: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
        vertex: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
        nvidia: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
        openrouter: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
        kilo: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
        unknown: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    },
    streamingRetry: {
        anthropic: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
        openai: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
        chatgpt: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
        gemini: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
        geminiCodeAssist: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
        vertex: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
        nvidia: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
        openrouter: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
        kilo: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
        unknown: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    },
};
function validateSettings(input) {
    if (typeof input !== "object" || input === null) {
        throw new Error("Settings must be an object");
    }
    var obj = input;
    var validateString = function (key, minLength) {
        if (minLength === void 0) { minLength = 0; }
        var v = obj[key];
        if (typeof v !== "string" || v.length < minLength) {
            throw new Error("Invalid ".concat(key, ": must be a non-empty string"));
        }
        return v;
    };
    var validateNumber = function (key, min, max) {
        var v = obj[key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
            throw new Error("Invalid ".concat(key, ": must be an integer between ").concat(min, " and ").concat(max));
        }
        return v;
    };
    var validateEnum = function (key, allowed) {
        var v = obj[key];
        if (typeof v !== "string" || !allowed.includes(v)) {
            throw new Error("Invalid ".concat(key, ": must be one of ").concat(allowed.join(", ")));
        }
        return v;
    };
    var validateBoolean = function (key) {
        var v = obj[key];
        if (typeof v !== "boolean") {
            throw new Error("Invalid ".concat(key, ": must be a boolean"));
        }
        return v;
    };
    return {
        logDir: validateString("logDir", 0),
        maxSessions: validateNumber("maxSessions", 0, 10000),
        redactPreset: validateEnum("redactPreset", ["secrets", "pii", "strict"]),
        redactReversible: validateBoolean("redactReversible"),
        redactPolicyFile: validateString("redactPolicyFile", 0),
        encryptionAtRest: validateBoolean("encryptionAtRest"),
        captureCleanupEnabled: validateBoolean("captureCleanupEnabled"),
        captureCleanupIntervalHours: validateNumber("captureCleanupIntervalHours", 1, 168),
        captureCleanupMaxAgeDays: validateNumber("captureCleanupMaxAgeDays", 1, 365),
        theme: validateEnum("theme", [
            "light",
            "dark",
            "system",
            "high-contrast",
            "material-light",
            "material-dark",
            "solarized-light",
            "solarized-dark",
            "dracula",
            "nord",
            "github-light",
            "github-dark",
            "one-dark",
            "monokai",
        ]),
        oidcEnabled: validateBoolean("oidcEnabled"),
        oidcPublicUrl: validateString("oidcPublicUrl", 0),
        showPageLoadTime: validateBoolean("showPageLoadTime"),
        detectorMode: validateEnum("detectorMode", ["rules", "llm", "hybrid", "auto"]),
        detectorModelDir: validateString("detectorModelDir", 0),
        detectorThreshold: (function () {
            var v = obj.detectorThreshold;
            if (typeof v !== "number" || v < 0 || v > 1) {
                throw new Error("Invalid detectorThreshold: must be a number between 0 and 1");
            }
            return v;
        })(),
        rateLimiter: (function () {
            var rl = obj.rateLimiter;
            if (typeof rl !== "object" || rl === null) {
                return exports.DEFAULT_SETTINGS.rateLimiter;
            }
            var rlObj = rl;
            var result = {};
            for (var _i = 0, _a = ["anthropic", "openai", "chatgpt", "gemini", "vertex", "nvidia", "openrouter", "kilo", "unknown"]; _i < _a.length; _i++) {
                var provider = _a[_i];
                var p = rlObj[provider];
                if (typeof p === "object" && p !== null) {
                    var pObj = p;
                    var maxRequests = Number.isInteger(pObj.maxRequests) && pObj.maxRequests >= 1 && pObj.maxRequests <= 10000 ? pObj.maxRequests : 60;
                    var windowMs = Number.isInteger(pObj.windowMs) && pObj.windowMs >= 100 && pObj.windowMs <= 24 * 60 * 60 * 1000 ? pObj.windowMs : 60000;
                    var bufferCapacity = Number.isInteger(pObj.bufferCapacity) && pObj.bufferCapacity >= 0 && pObj.bufferCapacity <= 10000 ? pObj.bufferCapacity : 10;
                    result[provider] = { maxRequests: maxRequests, windowMs: windowMs, bufferCapacity: bufferCapacity };
                }
                else {
                    result[provider] = { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 };
                }
            }
            return result;
        })(),
        streamingRetry: (function () {
            var sr = obj.streamingRetry;
            if (typeof sr !== "object" || sr === null) {
                return exports.DEFAULT_SETTINGS.streamingRetry;
            }
            var srObj = sr;
            var result = {};
            for (var _i = 0, _a = ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo", "unknown"]; _i < _a.length; _i++) {
                var provider = _a[_i];
                var p = srObj[provider];
                if (typeof p === "object" && p !== null) {
                    var pObj = p;
                    var enabled = typeof pObj.enabled === "boolean" ? pObj.enabled : true;
                    var maxRetries = Number.isInteger(pObj.maxRetries) && pObj.maxRetries >= 0 && pObj.maxRetries <= 10 ? pObj.maxRetries : 3;
                    var maxBufferSizeMB = Number.isInteger(pObj.maxBufferSizeMB) && pObj.maxBufferSizeMB >= 1 && pObj.maxBufferSizeMB <= 100 ? pObj.maxBufferSizeMB : 10;
                    result[provider] = { enabled: enabled, maxRetries: maxRetries, maxBufferSizeMB: maxBufferSizeMB };
                }
                else {
                    result[provider] = { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 };
                }
            }
            return result;
        })(),
    };
}
function mergeWithDefaults(partial) {
    return __assign(__assign({}, exports.DEFAULT_SETTINGS), partial);
}
function validateSettingsLenient(input) {
    if (typeof input !== "object" || input === null) {
        return exports.DEFAULT_SETTINGS;
    }
    var obj = input;
    return {
        logDir: typeof obj.logDir === "string" && obj.logDir.length >= 1
            ? obj.logDir
            : exports.DEFAULT_SETTINGS.logDir,
        maxSessions: typeof obj.maxSessions === "number" &&
            Number.isInteger(obj.maxSessions) &&
            obj.maxSessions >= 0 &&
            obj.maxSessions <= 10000
            ? obj.maxSessions
            : exports.DEFAULT_SETTINGS.maxSessions,
        redactPreset: typeof obj.redactPreset === "string" &&
            ["secrets", "pii", "strict"].includes(obj.redactPreset)
            ? obj.redactPreset
            : exports.DEFAULT_SETTINGS.redactPreset,
        redactReversible: typeof obj.redactReversible === "boolean"
            ? obj.redactReversible
            : exports.DEFAULT_SETTINGS.redactReversible,
        redactPolicyFile: typeof obj.redactPolicyFile === "string"
            ? obj.redactPolicyFile
            : exports.DEFAULT_SETTINGS.redactPolicyFile,
        encryptionAtRest: typeof obj.encryptionAtRest === "boolean"
            ? obj.encryptionAtRest
            : exports.DEFAULT_SETTINGS.encryptionAtRest,
        captureCleanupEnabled: typeof obj.captureCleanupEnabled === "boolean"
            ? obj.captureCleanupEnabled
            : exports.DEFAULT_SETTINGS.captureCleanupEnabled,
        captureCleanupIntervalHours: typeof obj.captureCleanupIntervalHours === "number" &&
            Number.isInteger(obj.captureCleanupIntervalHours) &&
            obj.captureCleanupIntervalHours >= 1 &&
            obj.captureCleanupIntervalHours <= 168
            ? obj.captureCleanupIntervalHours
            : exports.DEFAULT_SETTINGS.captureCleanupIntervalHours,
        captureCleanupMaxAgeDays: typeof obj.captureCleanupMaxAgeDays === "number" &&
            Number.isInteger(obj.captureCleanupMaxAgeDays) &&
            obj.captureCleanupMaxAgeDays >= 1 &&
            obj.captureCleanupMaxAgeDays <= 365
            ? obj.captureCleanupMaxAgeDays
            : exports.DEFAULT_SETTINGS.captureCleanupMaxAgeDays,
        theme: typeof obj.theme === "string" &&
            [
                "light",
                "dark",
                "system",
                "high-contrast",
                "material-light",
                "material-dark",
                "solarized-light",
                "solarized-dark",
                "dracula",
                "nord",
                "github-light",
                "github-dark",
                "one-dark",
                "monokai",
            ].includes(obj.theme)
            ? obj.theme
            : exports.DEFAULT_SETTINGS.theme,
        oidcEnabled: typeof obj.oidcEnabled === "boolean"
            ? obj.oidcEnabled
            : exports.DEFAULT_SETTINGS.oidcEnabled,
        oidcPublicUrl: typeof obj.oidcPublicUrl === "string"
            ? obj.oidcPublicUrl
            : exports.DEFAULT_SETTINGS.oidcPublicUrl,
        showPageLoadTime: typeof obj.showPageLoadTime === "boolean"
            ? obj.showPageLoadTime
            : exports.DEFAULT_SETTINGS.showPageLoadTime,
        detectorMode: typeof obj.detectorMode === "string" &&
            ["rules", "llm", "hybrid", "auto"].includes(obj.detectorMode)
            ? obj.detectorMode
            : exports.DEFAULT_SETTINGS.detectorMode,
        detectorModelDir: typeof obj.detectorModelDir === "string"
            ? obj.detectorModelDir
            : exports.DEFAULT_SETTINGS.detectorModelDir,
        detectorThreshold: typeof obj.detectorThreshold === "number" &&
            obj.detectorThreshold >= 0 &&
            obj.detectorThreshold <= 1
            ? obj.detectorThreshold
            : exports.DEFAULT_SETTINGS.detectorThreshold,
        rateLimiter: (function () {
            var rl = obj.rateLimiter;
            if (typeof rl !== "object" || rl === null) {
                return exports.DEFAULT_SETTINGS.rateLimiter;
            }
            var rlObj = rl;
            var result = {};
            for (var _i = 0, _a = ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo", "unknown"]; _i < _a.length; _i++) {
                var provider = _a[_i];
                var p = rlObj[provider];
                if (typeof p === "object" && p !== null) {
                    var pObj = p;
                    var maxRequests = Number.isInteger(pObj.maxRequests) && pObj.maxRequests >= 1 && pObj.maxRequests <= 10000 ? pObj.maxRequests : 60;
                    var windowMs = Number.isInteger(pObj.windowMs) && pObj.windowMs >= 100 && pObj.windowMs <= 24 * 60 * 60 * 1000 ? pObj.windowMs : 60000;
                    var bufferCapacity = Number.isInteger(pObj.bufferCapacity) && pObj.bufferCapacity >= 0 && pObj.bufferCapacity <= 10000 ? pObj.bufferCapacity : 10;
                    result[provider] = { maxRequests: maxRequests, windowMs: windowMs, bufferCapacity: bufferCapacity };
                }
                else {
                    result[provider] = exports.DEFAULT_SETTINGS.rateLimiter[provider];
                }
            }
            return result;
        })(),
        streamingRetry: (function () {
            var sr = obj.streamingRetry;
            if (typeof sr !== "object" || sr === null) {
                return exports.DEFAULT_SETTINGS.streamingRetry;
            }
            var srObj = sr;
            var result = {};
            for (var _i = 0, _a = ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo", "unknown"]; _i < _a.length; _i++) {
                var provider = _a[_i];
                var p = srObj[provider];
                if (typeof p === "object" && p !== null) {
                    var pObj = p;
                    var enabled = typeof pObj.enabled === "boolean" ? pObj.enabled : true;
                    var maxRetries = Number.isInteger(pObj.maxRetries) && pObj.maxRetries >= 0 && pObj.maxRetries <= 10 ? pObj.maxRetries : 3;
                    var maxBufferSizeMB = Number.isInteger(pObj.maxBufferSizeMB) && pObj.maxBufferSizeMB >= 1 && pObj.maxBufferSizeMB <= 100 ? pObj.maxBufferSizeMB : 10;
                    result[provider] = { enabled: enabled, maxRetries: maxRetries, maxBufferSizeMB: maxBufferSizeMB };
                }
                else {
                    result[provider] = exports.DEFAULT_SETTINGS.streamingRetry[provider];
                }
            }
            return result;
        })(),
    };
}
