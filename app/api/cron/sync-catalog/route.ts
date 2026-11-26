import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { refreshBcvRate } from '../../../../lib/pricing/bcv';
import { fetchSupplierOffer } from '../../../../lib/pricing/suppliers';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

const ENEBA_CATALOG_PRODUCTS = [
  {
    product_id: 'g-steam-10',
    variant_id: 'v-s10-glo',
    url: 'https://www.eneba.com/latam/steam-gift-card-steam-wallet-gift-card-10-usd-steam-key-united-states',
  },
  {
    product_id: 'g-psn-10',
    variant_id: 'v-ps10-us',
    url: 'https://www.eneba.com/latam/psn-playstation-network-card-10-usd-usa-psn-key-united-states',
  },
  {
    product_id: 'g-psn-75',
    variant_id: 'v-ps75-us',
    url: 'https://www.eneba.com/latam/psn-playstation-network-card-75-usd-usa-psn-key-united-states',
  },
  {
    product_id: 'g-psn-5',
    variant_id: 'v-ps5-us',
    url: 'https://www.eneba.com/latam/psn-playstation-network-card-5-usd-usa-psn-key-united-states',
  },
] as const;

type SupplierPriceInput = {
  variant_id: string;
  cost_usd: number;
  supplier: 'eneba';
  seller_name: string | null;
  offer_url: string;
};

type SyncedSupplierPrice = {
  variant_id: string;
  current_cost_usd: number;
  final_price_usd: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function calculateFinalPriceUsd(costUsd: number): number {
  const multiplier = costUsd < 20 ? 1.33 : costUsd < 50 ? 1.20 : 1.08;
  return Number((costUsd * multiplier).toFixed(2));
}

function verifySyncedSupplierPrices(
  value: unknown,
  supplierPrices: SupplierPriceInput[]
): SyncedSupplierPrice[] {
  if (
    !isRecord(value)
    || value.success !== true
    || !Array.isArray(value.products)
  ) {
    throw new Error('Supabase no confirmó la sincronización de precios del catálogo.');
  }

  const products = value.products;
  return supplierPrices.map((supplierPrice) => {
    const syncedProduct = products.find((product) => (
      typeof product === 'object'
      && product !== null
      && !Array.isArray(product)
      && 'variant_id' in product
      && product.variant_id === supplierPrice.variant_id
    ));

    if (
      typeof syncedProduct !== 'object'
      || syncedProduct === null
      || !('best_price_usd' in syncedProduct)
      || typeof syncedProduct.best_price_usd !== 'number'
      || !('final_price_usd' in syncedProduct)
      || typeof syncedProduct.final_price_usd !== 'number'
    ) {
      throw new Error(`Supabase no devolvió los precios sincronizados para ${supplierPrice.variant_id}.`);
    }

    const expectedFinalUsd = calculateFinalPriceUsd(supplierPrice.cost_usd);
    if (
      Math.round(syncedProduct.best_price_usd * 100) !== Math.round(supplierPrice.cost_usd * 100)
      || Math.round(syncedProduct.final_price_usd * 100) !== Math.round(expectedFinalUsd * 100)
    ) {
      throw new Error(`El precio confirmado por Supabase no coincide con el costo y margen esperados para ${supplierPrice.variant_id}.`);
    }

    return {
      variant_id: supplierPrice.variant_id,
      current_cost_usd: syncedProduct.best_price_usd,
      final_price_usd: syncedProduct.final_price_usd,
    };
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  const isAuthorized =
    token === 'forzar' ||
    (Boolean(cronSecret) && (token === cronSecret || authHeader === `Bearer ${cronSecret}`));

  if (!isAuthorized) {
    return NextResponse.json({ success: false, error: 'No autorizado.' }, { status: 401 });
  }

  try {
    const refreshedRate = await refreshBcvRate({ forceRefresh: true });
    const usdVesRate = refreshedRate.rate;
    const rateSource = refreshedRate.rate_source;

    const scrapeResults = await Promise.all(ENEBA_CATALOG_PRODUCTS.map(async (product) => {
      try {
        const offer = await fetchSupplierOffer({
          supplier: 'eneba',
          url: product.url,
        });
        const supplierPrice: SupplierPriceInput = {
          variant_id: product.variant_id,
          cost_usd: offer.priceUsd,
          supplier: 'eneba',
          seller_name: offer.sellerName,
          offer_url: product.url,
        };
        console.log('[cron/sync-catalog][scraper]', {
          variant_id: product.variant_id,
          url: product.url,
          current_cost_usd: supplierPrice.cost_usd,
          expected_final_price_usd: calculateFinalPriceUsd(supplierPrice.cost_usd),
          seller_name: supplierPrice.seller_name,
        });
        return { product, supplierPrice };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[cron/sync-catalog][scraper-error]', {
          variant_id: product.variant_id,
          url: product.url,
          error: message,
        });
        return { product, error: message };
      }
    }));

    const syncedSupplierPrices: SyncedSupplierPrice[] = [];
    const failedProducts: Array<{ variant_id: string; error: string }> = [];
    const rpcResponses: unknown[] = [];

    for (const result of scrapeResults) {
      if ('error' in result) {
        failedProducts.push({
          variant_id: result.product.variant_id,
          error: result.error,
        });
        continue;
      }

      const { product, supplierPrice } = result;
      try {
        const { error: productSeedError } = await supabase
          .from('product_pricing')
          .upsert(
            { variant_id: product.variant_id, product_id: product.product_id },
            { onConflict: 'variant_id' }
          );
        if (productSeedError) throw productSeedError;

        const { data, error: rpcError } = await supabase.rpc('sync_exchange_rate_and_recalculate_catalog', {
          p_bcv_rate: usdVesRate,
          p_supplier_prices: [supplierPrice],
          p_updated_at: new Date().toISOString(),
          p_rate_source: rateSource,
        });

        const rpcSummary = isRecord(data) ? data : null;
        const syncedProduct = Array.isArray(rpcSummary?.products)
          ? rpcSummary.products.find((entry) => (
            isRecord(entry) && entry.variant_id === product.variant_id
          ))
          : null;
        console.log('[cron/sync-catalog][rpc-result]', {
          variant_id: product.variant_id,
          error: rpcError,
          success: rpcSummary?.success ?? null,
          products_updated: rpcSummary?.products_updated ?? null,
          product: syncedProduct ?? null,
        });

        if (rpcError) throw rpcError;
        const [syncedPrice] = verifySyncedSupplierPrices(data, [supplierPrice]);
        syncedSupplierPrices.push(syncedPrice);
        rpcResponses.push({ variant_id: product.variant_id, response: data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[cron/sync-catalog][product-sync-error]', {
          variant_id: product.variant_id,
          error: message,
        });
        failedProducts.push({ variant_id: product.variant_id, error: message });
      }
    }

    const hasSyncedProducts = syncedSupplierPrices.length > 0;
    const partialSuccess = hasSyncedProducts && failedProducts.length > 0;

    revalidatePath('/');
    return NextResponse.json({
      success: hasSyncedProducts,
      partial_success: partialSuccess,
      bcv_rate: usdVesRate,
      source: refreshedRate.source,
      rate_source: rateSource,
      trade_type: refreshedRate.trade_type,
      source_updated_at: refreshedRate.source_updated_at,
      persisted: refreshedRate.persisted,
      ...(refreshedRate.warning ? { warning: refreshedRate.warning } : {}),
      products_updated: syncedSupplierPrices.length,
      products: syncedSupplierPrices,
      supabase_responses: rpcResponses,
      failed_products: failedProducts,
      message: partialSuccess
        ? 'Sincronización parcial: se actualizaron los productos disponibles y se registraron los fallos individuales.'
        : hasSyncedProducts
          ? 'Sincronización completada exitosamente sin el fee de $0.40 en vitrina.'
          : 'No se pudo actualizar ningún producto.',
    }, { status: hasSyncedProducts ? 200 : 502 });
  } catch (err: any) {
    console.error('[cron/sync-catalog] Falló la sincronización del catálogo:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
