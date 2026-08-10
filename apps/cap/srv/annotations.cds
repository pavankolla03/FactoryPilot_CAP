// CAP loads .cds at the root of srv/ but does not recurse into subfolders, so
// the per-domain annotation files are pulled in from here.
using from './annotations/config';
using from './annotations/token';
using from './annotations/admin';
using from './annotations/audit';
using from './annotations/cache';
using from './annotations/integration';
