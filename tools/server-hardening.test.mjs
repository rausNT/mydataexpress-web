import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../mainserver.pas', import.meta.url), 'utf8');

test('real server exposes an unauthenticated health check', () => {
  assert.match(source, /if URI = '\/health' then/);
  assert.match(source, /\{"status":"ok","mode":"server"\}/);
  assert.match(source, /ContentType := GetMimeType\('\.json'\)/);
});

test('static and ACME files stay inside their public roots', () => {
  assert.match(source, /function TryResolvePublicFile/);
  assert.match(source, /IncludeTrailingPathDelimiter\(ExpandFileName\(Root\)\)/);
  assert.match(source, /Result := Result and FileExists\(ExpandedFile\)/);
  assert.match(source, /if not TryResolvePublicFile\(StaticRoot, RelativePath, FlNm\) then/);
  assert.match(source, /TryResolvePublicFile\(AppPath \+ 'letsencrypt', RelativePath, FlNm\)/);
  assert.match(source, /AResponse\.Code := rcPageNotFound/);
});
