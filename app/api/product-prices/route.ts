import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const responseHeaders = { 'Cache-Control': 'no-store' };
const QUERY_TIMEOUT_MS = 10_000;

type PricingRow = {
  variant_id: string;
  [key: string]: unknown;
};

function pricesResponse(prices: Record<string, PricingRow>) {
  return NextResponse.json({ prices }, { headers: responseHeaders });
}

function getErrorDiagnostic(error: unknown) {
  const fields = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : {};

  return {
    message: typeof fields.message === 'string'
      ? fields.message
      : error instanceof Error ? error.message : 'Error desconocido al consultar Supabase.',
    code: typeof fields.code === 'string' ? fields.code : null,
    details: typeof fields.details === 'string' ? fields.details : null,
    hint: typeof fields.hint === 'string' ? fields.hint : null,
  };
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('variants');
  const variantIds = Array.from(new Set((query ?? '').split(',').filter(Boolean)));

  if (
    variantIds.length === 0
    || variantIds.length > 100
    || variantIds.some((id) => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
  ) {
    return pricesResponse({});
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from('product_pricing')
      .select('variant_id, final_price_usd, final_price_bs, bcv_rate')
      .in('variant_id', variantIds)
      .abortSignal(controller.signal);

    if (error) throw error;

    const prices = (data ?? []).reduce<Record<string, PricingRow>>((result, item) => {
      result[item.variant_id] = item;
      return result;
    }, {});

    return pricesResponse(prices);
  } catch (error) {
    const diagnostic = getErrorDiagnostic(error);
    const timedOut = controller.signal.aborted;
    console.error('[api/product-prices] Error al cargar precios.', {
      ...diagnostic,
      timedOut,
    });
    return NextResponse.json(
      {
        prices: {},
        error: timedOut
          ? 'La consulta de precios tardó demasiado. Intenta de nuevo.'
          : 'No se pudieron cargar los precios actuales del catálogo.',
      },
      { status: timedOut ? 503 : 500, headers: responseHeaders }
    );
  } finally {
    clearTimeout(timeout);
  }
}
