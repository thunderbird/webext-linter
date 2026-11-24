# Source archive fixtures

The archives tests/unit/source-archive.test.js extracts. Made once and committed. Run the
commands from a folder holding the tree, unless a line says otherwise. The tree:

```
README.md       "# Pebble Sorter\n\nBuild with `npm ci && npm run build`.\n"
package.json    '{"name":"pebble-sorter","version":"1.0.0"}\n'
src/lib/sort.js "export const sort = (a) => [...a].sort();\n"
src/main.js     'import { sort } from "./lib/sort.js";\nconsole.log(sort([3, 1, 2]));\n'
```

`T` stands for
`tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=2024-01-01T00:00:00Z --format=ustar`.

## The nine types ATN accepts, each holding the tree

- `source.tar`: `T -cf source.tar README.md package.json src`
- `source.tar.gz`, `source.tgz`: `gzip -9n < source.tar`
- `source.tar.bz2`, `source.tbz`: `bzip2 -9 < source.tar`
- `source.tar.xz`, `source.txz`: `xz -9 < source.tar`
- `source.zip`: `zip -qX -r source.zip README.md package.json src`
- `source.7z`: `npx 7z-wasm a -bd -mtm=off -mtc=off -mta=off source.7z README.md package.json src`
  (7z-wasm writes only below the folder it runs in)

## Layers

- `nested.zip`: `source.tar.gz` copied to `src-1.0.tar_ABC.gz`, the name ATN gives an
  upload, then `zip -qX nested.zip src-1.0.tar_ABC.gz`. It extracts to the tree.
- `beside.tar.gz`: the tree with `source.zip` copied to `vendor/lib.zip`, then
  `T -czf beside.tar.gz README.md package.json src vendor`. The inner zip stays packed.

## Links

- `links.tar`: the tree with `ln -s lib/sort.js src/inside.js` and
  `ln -s ../../outside.txt src/outside.js`, then `T -cf links.tar README.md package.json src`.
- `through-link.tar`: a link `lib -> /tmp`, then a file `z.txt` stored as `lib/z.txt`:
  `T -cf through-link.tar -C <link folder> lib -C <file folder> --transform='s,^z.txt,lib/z.txt,' z.txt`.
  Refused before `lib/z.txt` is written.

## Refused

- `dotdot.tar`: from a subfolder, `T -P -cf dotdot.tar ../x.txt`.
- `absolute.tar`: `T -P --transform='s,^,/abs/,' -cf absolute.tar x.txt`.
- `backslash.tar`: a file named `a\b.txt`, `T --no-unquote -cf backslash.tar 'a\b.txt'`.
- `twice.tar`: `T -cf twice.tar README.md`, then `T -rf twice.tar README.md`.
- `file-then-folder.tar`: a file `a`, then `b.txt` stored as `a/b.txt`:
  `T -cf file-then-folder.tar -C <a folder> a --transform='s,^b.txt,a/b.txt,' b.txt`.
- `link-then-file.tar`: a link `x -> ../../victim.txt`, then a file `x` from another folder:
  `T -cf link-then-file.tar -C <link folder> x -C <file folder> x`. Refused before the file
  is written through the link.
- `through-link-case.tar`: a link `lib -> /tmp`, then `z.txt` stored as `Lib/z.txt`, as
  `through-link.tar` is made. Names are compared case-folded.
- `latin1-name.tar`: a file named `caf\xe9.txt` in Latin-1, `T -cf latin1-name.tar "$(printf 'caf\xe9.txt')"`.
- A tar cut short is made by the test itself from `source.tar`.
- `hardlink.tar`: `a.txt` and `ln a.txt b.txt`, then `T -cf hardlink.tar a.txt b.txt`.
- `encrypted.zip`: `zip -qX -P secret encrypted.zip README.md`.
- `source.tar.zst`: `zstd -q -19 source.tar -o source.tar.zst`, a type ATN does not accept.
