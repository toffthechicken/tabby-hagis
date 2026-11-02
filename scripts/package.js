/**
 * 배포용 패키지 만들기 — Node.js 없이 install.cmd 더블클릭만으로 설치된다.
 *   npm run package  →  release\hagis-<버전>.zip  (+ .sha256)
 * Build the release zip: unzip → double-click install.cmd, no Node.js needed.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const releaseDir = path.join(root, 'release')
const name = `hagis-${pkg.version}`
const stage = path.join(releaseDir, name)

if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
    console.error('dist/index.js 가 없습니다. 먼저 npm run build 를 실행하세요.')
    process.exit(1)
}

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
// 소스맵은 배포에 필요 없다
fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), {
    recursive: true,
    filter: src => !src.endsWith('.map'),
})
for (const file of ['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'install.cmd', 'uninstall.cmd']) {
    if (!fs.existsSync(path.join(root, file))) {
        console.error(`${file} 가 없습니다.`)
        process.exit(1)
    }
    fs.copyFileSync(path.join(root, file), path.join(stage, file))
}

const zip = path.join(releaseDir, `${name}.zip`)
fs.rmSync(zip, { force: true })
// Windows 10 이상에 기본 포함된 tar(bsdtar)로 zip 생성.
// PATH 의 tar 는 Git Bash 의 GNU tar 일 수 있어(zip 을 못 만든다) System32 의 것을 직접 쓴다.
if (process.platform === 'win32') {
    const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(fs.existsSync(bsdtar) ? bsdtar : 'tar', ['-a', '-c', '-f', zip, name], { cwd: releaseDir, stdio: 'inherit' })
} else {
    execFileSync('zip', ['-r', '-q', zip, name], { cwd: releaseDir, stdio: 'inherit' })
}
const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
fs.writeFileSync(`${zip}.sha256`, `${hash}  ${path.basename(zip)}
`)
console.log(`배포 패키지: ${zip}`)
console.log(`SHA-256: ${hash}`)
console.log('받는 PC에서: 압축 풀기 → install.cmd 더블클릭 → Tabby 재시작')
