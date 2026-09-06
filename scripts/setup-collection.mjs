/**
 * Create the `locals` PocketBase collection if it does not already exist.
 * Idempotent — safe to run repeatedly. Run once before the first scrape:
 *
 *   node scripts/setup-collection.mjs
 */
import { pbAuth, pbFetch } from './lib/pb.mjs';

const num = (name) => ({ name, type: 'number', required: false });
const txt = (name) => ({ name, type: 'text', required: false, max: 0 });

const COLLECTION = {
  name: 'locals',
  type: 'base',
  // public read; writes are superuser-only (rules left null)
  listRule: '',
  viewRule: '',
  fields: [
    { name: 'slug', type: 'text', required: true, max: 120 },
    num('local_no'),
    txt('city'),
    txt('state'),
    num('lat'),
    num('lng'),
    num('yearly_salary'),
    num('hourly_rate'),
    num('total_package'),
    num('col_pct'),
    num('adjusted_base_wage'),
    num('defined_pension'),
    num('contribution_pension'),
    num('k401'),
    num('vacation'),
    num('hw'),
    num('nebf_pension'),
    num('dues'),
    { name: 'wage_sheet_url', type: 'url', required: false },
    txt('source_updated'),
    { name: 'raw', type: 'json', required: false, maxSize: 2000000 },
    { name: 'scraped_at', type: 'date', required: false },
  ],
  indexes: ['CREATE UNIQUE INDEX `idx_locals_slug` ON `locals` (`slug`)'],
};

const ctx = await pbAuth();

const existing = await pbFetch(ctx, '/api/collections/locals').catch((e) => {
  if (e.status === 404) return null;
  throw e;
});

if (existing) {
  console.log(`Collection "locals" already exists (id ${existing.id}) — nothing to do.`);
} else {
  const created = await pbFetch(ctx, '/api/collections', {
    method: 'POST',
    body: JSON.stringify(COLLECTION),
  });
  console.log(`Created collection "locals" (id ${created.id}) with ${created.fields.length} fields.`);
}
