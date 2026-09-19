# vendor/

`zod.bundle.js` is Zod v3 (see version pinned below), bundled as a single
IIFE that exposes `self.Zod = { z }`. Built with esbuild from the published
npm package — nothing hand-modified.

MV3 forbids loading remotely-hosted code, so this has to be vendored rather
than pulled from a CDN at runtime. To rebuild after a version bump:

```
mkdir /tmp/zodbuild && cd /tmp/zodbuild
npm init -y
npm install zod@3
npm install --save-dev esbuild
echo 'import { z } from "zod"; self.Zod = { z };' > entry.js
npx esbuild entry.js --bundle --format=iife --outfile=zod.bundle.js --target=es2020 --minify
cp zod.bundle.js <path to this vendor/ dir>
```

Pinned version: zod@3.25.76
