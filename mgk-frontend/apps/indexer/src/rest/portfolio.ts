import type { FastifyInstance } from 'fastify';
import type { Store } from '../store.js';

export async function portfolioRoutes(app: FastifyInstance, store: Store): Promise<void> {
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
}
