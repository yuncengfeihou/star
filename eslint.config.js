// eslint.config.js - ESLint 扁平配置（ESLint 9+）
// 目标不是「统一风格」，而是拦住会真正影响运行的问题：
//   1. no-undef  —— 宿主 API（jQuery / toastr / SillyTavern 等）拼写错误或忘记导入
//   2. no-unused-vars —— 重构后遗留的无用导入与死变量
//   3. 基础正确性规则（重复键、不可达代码、redeclare 等）
// 说明：本扩展无构建步骤，ESLint 仅作为开发期门禁，不参与运行时。

// 宿主（SillyTavern）与浏览器全局：只声明扩展实际用到的，避免规则误报
const HOST_GLOBALS = Object.fromEntries([
    // SillyTavern / 第三方宿主注入
    '$', 'jQuery', 'toastr', 'SillyTavern', '_',
    // 动态注入脚本后暴露的库全局（见 ui/screenshot.js）
    'modernScreenshot',
    // 浏览器标准对象
    'window', 'document', 'console', 'location', 'navigator', 'history', 'screen', 'self', 'globalThis',
    'fetch', 'Headers', 'Request', 'Response', 'XMLHttpRequest',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
    'queueMicrotask', 'structuredClone',
    'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
    'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'Node', 'NodeFilter',
    'Blob', 'File', 'FileReader', 'FormData', 'URL', 'URLSearchParams',
    'Image', 'DOMParser', 'XMLSerializer', 'getComputedStyle', 'matchMedia',
    'TextEncoder', 'TextDecoder', 'atob', 'btoa',
    'localStorage', 'sessionStorage', 'indexedDB', 'IDBKeyRange', 'caches',
    'performance', 'crypto', 'Worker', 'OffscreenCanvas', 'createImageBitmap',
    'HTMLCanvasElement', 'CanvasRenderingContext2D', 'CSSRule', 'alert', 'confirm', 'prompt',
].map(name => [name, 'readonly']));

export default [
    {
        ignores: [
            'node_modules/**',
            'lib/**',          // modern-screenshot 上游压缩副本
            'worker.js',       // 同库的 Web Worker 压缩版
            '.claude/**',
            '.codegraph/**',
            '.star-test/**',   // 临时核对脚本（浏览器端探针，含 devtools 专用全局）
            'scripts/**',      // Node 侧开发脚本
        ],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: HOST_GLOBALS,
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'warn',
        },
        rules: {
            // ---- 正确性（error）----
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-dupe-class-members': 'error',
            'no-redeclare': 'error',
            'no-fallthrough': 'error',
            'no-unsafe-finally': 'error',
            'no-unsafe-negation': 'error',
            'no-obj-calls': 'error',
            'no-sparse-arrays': 'error',
            'use-isnan': 'error',
            'valid-typeof': 'error',
            'no-constant-binary-expression': 'error',
            'no-self-assign': 'error',
            'no-self-compare': 'error',
            'no-unmodified-loop-condition': 'error',
            'no-template-curly-in-string': 'warn',

            // ---- 卫生（warn，不阻断）----
            'no-unused-vars': ['warn', {
                args: 'after-used',
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',   // 空 catch 在本项目中是刻意的（取消/静默降级）
            }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-var': 'warn',
            'prefer-const': ['warn', { destructuring: 'all' }],
            'no-useless-escape': 'warn',
            'no-useless-return': 'warn',
            'no-unused-private-class-members': 'warn',
            'no-async-promise-executor': 'error',
            'require-atomic-updates': 'off',   // 本项目的状态写入模式（缓存重建）会误报
        },
    },
    {
        // 开发脚本（Node 环境）
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
        },
    },
];
