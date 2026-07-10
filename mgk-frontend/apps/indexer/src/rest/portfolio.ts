import type { FastifyInstance } from 'fastify';
import type { Store } from '../store.js';
import { getPortfolioQueue } from '../portfolio-queue.js';

export async function portfolioRoutes(app: FastifyInstance, store: Store): Promise<void> {
  /**
   * POST /api/portfolio/request-creation
   * Frontend calls this when a user tries to initialize their portfolio
   * but the account doesn't exist yet. Keeper drains this queue on each cycle.
   */
  app.post<{ Body: { userPubkey: string } }>(
    '/api/portfolio/request-creation',
    async (req, reply) => {
      const { userPubkey } = req.body ?? {};
      if (!userPubkey || typeof userPubkey !== 'string') {
        return reply.code(400).send({ error: 'userPubkey required' });
      }
      try {
        // Validate it's a valid base58 pubkey
        const { PublicKey } = await import('@solana/web3.js');
        new PublicKey(userPubkey);
      } catch {
        return reply.code(400).send({ error: 'invalid userPubkey' });
      }

      const queue = getPortfolioQueue();
      queue.add(userPubkey);
      console.log(`[portfolio-queue] REST: added ${userPubkey} (queue size: ${queue.size})`);
      return { ok: true, queueSize: queue.size };
    },
  );

  /**
   * GET /api/portfolio/address?userPubkey=...
   * Returns the portfolio address for a user (from DB lookup).
   * Returns 404 if no portfolio found.
   */
  app.get(
    '/api/portfolio/address',
    async (req, reply) => {
      const userPubkey = (req.query as Record<string, string | undefined>).userPubkey;
      if (!userPubkey || typeof userPubkey !== 'string') {
        return reply.code(400).send({ error: 'userPubkey query param required' });
      }
      try {
        const { PublicKey: PK } = await import('@solana/web3.js');
        new PK(userPubkey);
      } catch (e) {
        console.error('[portfolio] PublicKey error:', e, 'userPubkey:', userPubkey, 'length:', userPubkey.length);
        return reply.code(400).send({ error: 'invalid userPubkey' });
      }

      const row = store.getPortfolio.get(userPubkey) as { portfolio_pubkey: string } | undefined;
      if (!row) {
        return reply.code(404).send({ error: 'portfolio not found' });
      }
      return { portfolioAddress: row.portfolio_pubkey };
    },
  );

  /**
   * GET /api/portfolio/queue-size
   * Returns current queue size for monitoring.
   */
  app.get('/api/portfolio/queue-size', async () => {
    const queue = getPortfolioQueue();
    return { size: queue.size };
  });
}
