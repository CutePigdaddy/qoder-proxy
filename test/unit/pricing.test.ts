import { describe, expect, it } from 'vitest';
import { loadRateCard, normaliseModel, pickTier, priceUsage, rateFor, rateView, roundMoney, isPeak } from '../../src/obs/pricing.js';

describe('pricing', () => {
  const tmpDir = '/tmp/qoder-pricing-test';

  describe('loadRateCard', () => {
    it('loads a valid pricing table', async () => {
      const card = loadRateCard('config/pricing.json');
      expect(card.currency).toBe('CNY');
      expect(card.unit).toBe(1_000_000);
      expect(Object.keys(card.models).length).toBeGreaterThan(0);
    });

    it('returns empty card when file missing', () => {
      const card = loadRateCard('/nonexistent/path/pricing.json');
      expect(card).toEqual({ currency: 'CNY', unit: 1_000_000, retrievedAt: '', models: {} });
    });
  });

  describe('normaliseModel', () => {
    it('collapses case and separators', () => {
      expect(normaliseModel('Qwen3.8-Max')).toBe(normaliseModel('qwen 3.8 max'));
      expect(normaliseModel('Qwen3.8-Max')).toBe(normaliseModel('QWEN38MAX'));
      expect(normaliseModel('DeepSeek-V4-Pro')).toBe(normaliseModel('deepseek v4 pro'));
    });
  });

  describe('rateFor', () => {
    it('finds model by exact name', () => {
      const card = loadRateCard('config/pricing.json');
      const rate = rateFor(card, 'Qwen3.8-Max');
      expect(rate).toBeTruthy();
      expect(rate?.tiers.length).toBe(1);
    });

    it('returns null for unknown model', () => {
      const card = loadRateCard('config/pricing.json');
      expect(rateFor(card, 'Unknown-Model-XYZ')).toBeNull();
    });
  });

  describe('pickTier', () => {
    it('selects the first tier that fits promptTokens', () => {
      const card = loadRateCard('config/pricing.json');
      const rate = rateFor(card, 'Qwen3.7-Flash')!;
      // 20k tokens -> should use 32k tier
      const tier = pickTier(rate, 20_000);
      expect(tier.upTo).toBe(32000);
      // 50k tokens -> should use 256k tier
      const tier2 = pickTier(rate, 50_000);
      expect(tier2.upTo).toBe(256000);
    });
  });

  describe('isPeak', () => {
    it('identifies DeepSeek peak hours (Beijing time)', () => {
      const card = loadRateCard('config/pricing.json');
      const rate = rateFor(card, 'DeepSeek-V4-Pro')!;
      if (!rate.peak) throw new Error('Expected peak rule');

      // Test off-peak (e.g., 20:00 Beijing on weekday)
      const offPeakTs = Date.UTC(2026, 9, 22, 12, 0, 0); // 2026-10-22 20:00 UTC = 2026-10-23 04:00 Beijing
      expect(isPeak(rate.peak, offPeakTs)).toBe(false);

      // Test peak (e.g., 10:00 Beijing on weekday)
      const peakTs = Date.UTC(2026, 9, 22, 2, 0, 0); // 2026-10-22 10:00 Beijing
      expect(isPeak(rate.peak, peakTs)).toBe(true);

      // Test weekend (should be off-peak even during "peak" windows)
      const weekendTs = Date.UTC(2026, 9, 18, 10, 0, 0); // 2026-10-18 18:00 UTC = 2026-10-19 02:00 Beijing (Sunday)
      expect(isPeak(rate.peak, weekendTs)).toBe(false);
    });
  });

  describe('priceUsage', () => {
    it('calculates cost correctly with caching', () => {
      const card = loadRateCard('config/pricing.json');
      const rate = rateFor(card, 'Qwen3.8-Flash')!;
      const usage = { ts: Date.now(), inputTokens: 1000, cachedTokens: 0, outputTokens: 500 };
      const breakdown = priceUsage(card, rate, usage);
      expect(breakdown.cost).toBeCloseTo((1000 * 0.8 + 500 * 2.7) / 1_000_000, 6);
    });

    it('applies peak multiplier for DeepSeek', () => {
      const card = loadRateCard('config/pricing.json');
      const rate = rateFor(card, 'DeepSeek-V4-Pro')!;
      if (!rate.peak) throw new Error('Expected peak rule');

      const peakTs = Date.UTC(2026, 9, 22, 2, 0, 0); // 2026-10-22 10:00 Beijing
      const usage = { ts: peakTs, inputTokens: 1000, cachedTokens: 0, outputTokens: 500 };
      const breakdown = priceUsage(card, rate, usage);
      expect(breakdown.peak).toBe(true);
      // Should be double the base rate
      const expectedBase = (1000 * 4.5 + 500 * 13.5) / 1_000_000;
      expect(breakdown.cost).toBeCloseTo(expectedBase * 2, 6);
    });
  });

  describe('rateView', () => {
    it('extracts first tier as representative price', () => {
      const card = loadRateCard('config/pricing.json');
      const rate = rateFor(card, 'GLM-5.3-Flash')!;
      const view = rateView(rate);
      expect(view.input).toBe(0.8);
      expect(view.output).toBe(2.8);
      expect(view.cachedInput).toBe(0.23);
    });
  });

  describe('roundMoney', () => {
    it('rounds to 6 decimal places', () => {
      expect(roundMoney(0.123456789)).toBe(0.123457);
      expect(roundMoney(0.0000001)).toBe(0);
    });
  });
});
