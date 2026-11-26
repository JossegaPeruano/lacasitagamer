import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { refreshBcvRate } from '../../../../lib/pricing/bcv';
import { getSupabaseServerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const FIXED_MARGIN_USD = 3;

type CatalogSyncProduct = {
  variant_id: string;
  product_id: string;
  base_price_usd: number;
  final_price_usd: number;
  final_price_bs: number;
};

type SkippedProduct = {
  variant_id: string;
  product_id: string;
};

type CatalogSyncSummary = {
  success: true;
  bcv_rate: number;
  updated_at: string;
  products_updated: number;
  products: CatalogSyncProduct[];
  skipped_products: SkippedProduct[];
};

function jsonResponse(body: Record<string, unknown>) {
  return NextResponse.json(body, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'No se pudo completar la actualización del catálogo.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCatalogSyncSummary(value: unknown): CatalogSyncSummary {
  if (
    !isRecord(value)
    || value.success !== true
    || typeof value.bcv_rate !== 'number'
    || typeof value.updated_at !== 'string'
    || typeof value.products_updated !== 'number'
    || !Number.isInteger(value.products_updated)
    || !Array.isArray(value.products)
    || !Array.isArray(value.skipped_products)
  ) {
    throw new Error('Supabase devolvió un resumen inválido al actualizar el catálogo.');
  }

  const products = value.products.map((product): CatalogSyncProduct => {
    if (
      !isRecord(product)
      || typeof product.variant_id !== 'string'
      || typeof product.product_id !== 'string'
      || typeof product.base_price_usd !== 'number'
      || typeof product.final_price_usd !== 'number'
      || typeof product.final_price_bs !== 'number'
    ) {
      throw new Error('Supabase devolvió precios inválidos en el resumen de actualización.');
    }

    return {
      variant_id: product.variant_id,
      product_id: product.product_id,
      base_price_usd: product.base_price_usd,
      final_price_usd: product.final_price_usd,
      final_price_bs: product.final_price_bs,
    };
  });

  const skippedProducts = value.skipped_products.map((product): SkippedProduct => {
    if (
      !isRecord(product)
      || typeof product.variant_id !== 'string'
      || typeof product.product_id !== 'string'
    ) {
      throw new Error('Supabase devolvió un producto omitido inválido en el resumen.');
    }

    return {
      variant_id: product.variant_id,
      product_id: product.product_id,
    };
  });

  if (products.length !== value.products_updated) {
    throw new Error('La cantidad de productos del resumen no coincide con la actualización confirmada.');
  }

  return {
    success: true,
    bcv_rate: value.bcv_rate,
    updated_at: value.updated_at,
    products_updated: value.products_updated,
    products,
    skipped_products: skippedProducts,
  };
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return jsonResponse({
      success: false,
      error: 'No autorizado.',
    });
  }

  try {
    const refreshedRate = await refreshBcvRate({ forceRefresh: true });
    const checkedAt = new Date().toISOString();
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase.rpc('recalculate_catalog_with_fixed_margin', {
      p_bcv_rate: refreshedRate.rate,
      p_margin_usd: FIXED_MARGIN_USD,
      p_updated_at: checkedAt,
      p_rate_source: refreshedRate.rate_source,
    });

    if (error) throw error;

    const summary = parseCatalogSyncSummary(data);
    revalidatePath('/');
    return jsonResponse({
      ...summary,
      source: refreshedRate.source,
      rate_source: refreshedRate.rate_source,
      trade_type: refreshedRate.trade_type,
      source_updated_at: refreshedRate.source_updated_at,
      stale: refreshedRate.stale,
      cached: refreshedRate.cached ?? false,
      persisted: true,
      ...(refreshedRate.warning ? { rate_refresh_warning: refreshedRate.warning } : {}),
      margin_usd: FIXED_MARGIN_USD,
    });
  } catch (error) {
    console.error('[cron/test-steam] Falló la actualización del catálogo:', error);
    return jsonResponse({
      success: false,
      source: null,
      timestamp: new Date().toISOString(),
      error: getErrorMessage(error),
    });
  }
}
