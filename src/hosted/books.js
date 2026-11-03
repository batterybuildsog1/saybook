// Five free books per family account, for life (Alan, 2026-11-02: "free for the first 4-5 stories and only charge
// after that"). A book counts once its first pages form (POST /api/stories/:id/book). Its row here outlives the story,
// so deleting a book doesn't give the credit back; rows go only with the account. A subscription lifts the limit.
// Drafts are never blocked from saving: only starting a new book and forming pages of an uncounted one are refused.
import { now } from './util.js';
export const FREE_BOOKS = 5;
const PAID = "SELECT 1 FROM hosted_accounts WHERE account_id=? AND subscription_status='active' AND subscription_end>?";
export const FREE_BOOKS_MESSAGE = 'All the free books are made. Your words are saved. Ask a grown-up to keep making new books.';

export async function books(env, accountId) {
 const r = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM hosted_books WHERE account_id=?) AS made, EXISTS(${PAID}) AS paid`)
  .bind(accountId, accountId, now()).first();
 return { free_books: FREE_BOOKS, books_made: r.made, free_books_left: Math.max(0, FREE_BOOKS - r.made), paid: !!r.paid };
}

// storyId null: may the family start a new book? With claim, one conditional insert counts the book, so two books
// racing for the last free place can't both get it.
export async function bookGate(env, accountId, storyId = null, claim = false) {
 if (claim) {
  await env.DB.prepare(`INSERT OR IGNORE INTO hosted_books(account_id,story_id,at) SELECT ?,?,?
   WHERE EXISTS(SELECT 1 FROM stories WHERE account_id=? AND id=?)
   AND (EXISTS(${PAID}) OR (SELECT COUNT(*) FROM hosted_books WHERE account_id=?) < ?)`)
   .bind(accountId, storyId, now(), accountId, storyId, accountId, now(), accountId, FREE_BOOKS).run();
 }
 const r = await env.DB.prepare(`SELECT EXISTS(SELECT 1 FROM hosted_books WHERE account_id=? AND story_id=?) AS counted,
  EXISTS(${PAID}) AS paid, (SELECT COUNT(*) FROM hosted_books WHERE account_id=?) AS made`)
  .bind(accountId, storyId || '', accountId, now(), accountId).first();
 const ok = claim ? !!r.counted : !!(r.counted || r.paid || r.made < FREE_BOOKS);
 return ok ? { ok: true } : { ok: false, error: 'limit', reason: 'free_books_used', message: FREE_BOOKS_MESSAGE };
}
