# 从开发版 index.html 生成 file:// 可直接打开的单文件版 mahjong-standalone.html
# 原理：ES Module 在 file:// 下被 CORS 拦截（手机直接打开 HTML 就是一片绿底），
#       用 esbuild 打成 IIFE 后以 <script> 内联，彻底摆脱 module/importmap 限制。
import io, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'index.html')
OUT = os.path.join(ROOT, 'mahjong-standalone.html')
APP_MJS = os.path.join(ROOT, '_app_for_bundle.mjs')
NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.12.0/node.exe'
ESBUILD = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild/bin/esbuild'

html = io.open(SRC, encoding='utf-8').read()

m = re.search(r'<script type="module">(.*?)</script>', html, re.S)
if not m:
    sys.exit('FATAL: 未找到 <script type="module"> 块')
io.open(APP_MJS, 'w', encoding='utf-8', newline='').write(m.group(1))

r = subprocess.run(
    [NODE, ESBUILD, APP_MJS, '--bundle', '--format=iife', '--minify',
     # 兼容旧 WebView：转译 ?? / ?. 等新语法；解构保留原生（chrome49+/safari10+ 均支持）
     '--target=es2019',
     '--log-level=warning', '--outfile=' + os.path.join(ROOT, '_bundle_iife.js')],
    capture_output=True, text=True)
if r.returncode != 0:
    sys.exit('esbuild 失败:\n' + r.stdout + r.stderr)
if r.stderr.strip():
    print(r.stderr.strip())

bundle = io.open(os.path.join(ROOT, '_bundle_iife.js'), encoding='utf-8').read()
# IIFE 里可能含 </script> 字符串（如正则/模板），转义保命
bundle_safe = bundle.replace('</script>', '<\\/script>')

out = html[:m.start()] + '<script>\n' + bundle_safe + '\n</script>' + html[m.end():]
io.open(OUT, 'w', encoding='utf-8', newline='').write(out)

os.remove(APP_MJS)
os.remove(os.path.join(ROOT, '_bundle_iife.js'))
print('OK ->', OUT, '| size =', len(out.encode('utf-8')), 'bytes')
