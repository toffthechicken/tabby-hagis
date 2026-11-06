const path = require('path')

const plugin = (env, argv) => ({
    name: 'plugin',
    target: 'node',
    entry: path.resolve(__dirname, 'src/index.ts'),
    context: __dirname,
    devtool: argv.mode === 'development' ? 'eval-source-map' : 'source-map',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        libraryTarget: 'umd',
        publicPath: 'auto',
    },
    optimization: {
        minimize: false,
    },
    resolve: {
        modules: ['.', 'src', 'node_modules'].map(x => path.join(__dirname, x)),
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        configFile: path.resolve(__dirname, 'tsconfig.json'),
                    },
                },
            },
        ],
    },
    // Tabby가 런타임에 제공하는 모듈은 번들에 넣지 않는다 (DI 인스턴스 중복 방지)
    externals: [
        '@electron/remote',
        'electron',
        'fs',
        'os',
        'path',
        // Node 24 내장 SQLite — Chrome·Edge 방문 기록을 읽는 데 쓴다 (webpack 이 모르는 'node:' 모듈이라 그대로 require)
        { 'node:sqlite': 'commonjs node:sqlite' },
        'ngx-toastr',
        '@tabby-gang/windows-process-tree',
        /^@angular/,
        /^@ng-bootstrap/,
        /^rxjs/,
        /^tabby-/,
    ],
})

/**
 * 문서 뷰어 페이지 (dist/viewer/viewer.js) — 웹 패널 안에서 열리는 일반 웹 페이지라 Node 용이 아니라 웹용으로 묶는다.
 * HTML·CSS·rhwp 의 .wasm 은 scripts/copy-viewer.js 가 dist/viewer 로 복사한다.
 */
const viewer = (env, argv) => ({
    name: 'viewer',
    target: 'web',
    entry: path.resolve(__dirname, 'src/viewer/viewer.ts'),
    context: __dirname,
    devtool: false,
    output: {
        path: path.resolve(__dirname, 'dist/viewer'),
        filename: 'viewer.js',
        chunkFilename: 'viewer-[name].js',
        publicPath: 'auto',
        clean: true, // 이전 빌드의 해시 이름 파일이 쌓이지 않게
    },
    performance: { hints: false },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: {
                    loader: 'ts-loader',
                    options: { configFile: path.resolve(__dirname, 'src/viewer/tsconfig.json') },
                },
            },
            // HWP 엔진(.wasm)은 뷰어 페이지가 고정된 이름(rhwp_bg.wasm)으로 받아 간다
            {
                test: /rhwp_bg\.wasm$/,
                type: 'asset/resource',
                generator: { filename: 'rhwp_bg.wasm' },
            },
        ],
    },
})

module.exports = (env, argv) => [plugin(env, argv), viewer(env, argv)]
