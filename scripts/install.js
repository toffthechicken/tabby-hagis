/**
 * 빌드된 hagis 플러그인을 Tabby 사용자 플러그인 폴더에 설치한다.
 *   Windows: %APPDATA%\tabby\plugins\node_modules\tabby-hagis
 *
 * node_modules 는 복사하지 않는다 — @electron/remote, @angular 등은
 * Tabby 본체의 모듈을 써야 하므로 개발용 복사본이 끼어들면 안 된다.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

function pluginsDir () {
    if (process.env.TABBY_PLUGINS_DIR) {
        return process.env.TABBY_PLUGINS_DIR
    }
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA, 'tabby', 'plugins')
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'tabby', 'plugins')
    }
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'tabby', 'plugins')
}

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist', 'index.js')
if (!fs.existsSync(dist)) {
    console.error('dist/index.js 가 없습니다. 먼저 npm run build 를 실행하세요.')
    process.exit(1)
}

const target = path.join(pluginsDir(), 'node_modules', 'tabby-hagis')
fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })
fs.copyFileSync(path.join(root, 'package.json'), path.join(target, 'package.json'))
fs.cpSync(path.join(root, 'dist'), path.join(target, 'dist'), { recursive: true })
for (const extra of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (fs.existsSync(path.join(root, extra))) {
        fs.copyFileSync(path.join(root, extra), path.join(target, extra))
    }
}
console.log(`hagis 설치 완료 → ${target}`)
console.log('Tabby를 다시 시작하면 적용됩니다.')
