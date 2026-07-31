// The backup file's format version.
//
// Lives in lib rather than beside the restore engine so the import wizard — a
// client component — can compare against it without pulling Prisma into the
// browser bundle.
//
// v1: accounts, categories, transactions (plus arrays carried but not restored).
// v2: adds creditCards, sealed exactly as stored.
//
// Bump when the shape changes in a way an older build can't tolerate blindly.
// Older backups restore into newer builds unchanged; the wizard warns only in
// the other direction, where a file written by a newer Ledgerly carries fields
// this build can't know about.
export const BACKUP_FORMAT_VERSION = 2;
