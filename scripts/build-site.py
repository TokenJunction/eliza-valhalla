from pathlib import Path
import shutil

out = Path('site-build')
if out.exists():
    shutil.rmtree(out)
shutil.copytree(
    '.',
    out,
    ignore=shutil.ignore_patterns(
        '.git', '.github', '.wrangler', '.vscode', '__pycache__', 'node_modules', 'site-build',
        'scripts',
        '.env', '.env.*', 'package.json', 'package-lock.json', 'bun.lock',
        'bun.lockb', 'render.yaml', 'valhalla-elizaos', 'supabase', 'lib',
        'valhallaQueueEngine.js', 'valhallaQueueEngine.test.cjs', 'bridge.test.cjs', 'setup.ps1', 'setup.sh',
        'customer', 'provider-harness'
    )
)

gate = out / 'app/gate.js'
text = gate.read_text()
a = '  function mountTurnstile() {'
b = '  function termsOk() {'
assert text.count(a) == text.count(b) == 1
start, end = text.index(a), text.index(b)
assert end > start and 'turnstile.render' in text[start:end]
gate.write_text(text[:start] + '  function mountTurnstile() { markHuman(); }\n\n' + text[end:])
errors = out / 'errors.js'
text = errors.read_text()
needle = "frame.title = 'Valhalla read-only preview';"
if needle in text:
    start = text.rfind('\n(function () {', 0, text.index(needle))
    assert start > 0
    text = text[:start] + '\n'
assert 'root.ValhallaErrors = ' in text
errors.write_text(text)

assert (out / 'assets/mark.svg').is_file()
assert (out / 'assets/mech.jpg').is_file()
assert (out / 'app/index.html').read_bytes() == Path('app/index.html').read_bytes()
