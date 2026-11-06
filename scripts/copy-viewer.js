/**
 * 문서 뷰어에 필요한 정적 파일을 dist/viewer 로 복사한다 (webpack 이 묶은 viewer.js 옆에 둔다).
 *  - viewer.html / viewer.css : src/viewer
 *  (HWP 엔진 rhwp_bg.wasm 은 webpack 이 viewer.js 와 함께 내보낸다)
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const out = path.join(root, 'dist', 'viewer')
fs.mkdirSync(out, { recursive: true })
const files = [
    [path.join(root, 'src', 'viewer', 'viewer.html'), 'viewer.html'],
    [path.join(root, 'src', 'viewer', 'viewer.css'), 'viewer.css'],
]
for (const [from, name] of files) {
    if (!fs.existsSync(from)) {
        console.error(`${from} 가 없습니다. npm install 을 먼저 실행하세요.`)
        process.exit(1)
    }
    fs.copyFileSync(from, path.join(out, name))
}
console.log(`뷰어 파일 복사 완료 → ${out}`)
