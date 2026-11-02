const path = require('path')

module.exports = (env, argv) => ({
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
        'ngx-toastr',
        '@tabby-gang/windows-process-tree',
        /^@angular/,
        /^@ng-bootstrap/,
        /^rxjs/,
        /^tabby-/,
    ],
})
