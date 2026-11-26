import { getSupabaseServerClient } from '../supabase/server';

const MONTOSVE_RATES_URL = 'https://api.montosve.com/v1/fx/rates?trade_type=buy';
const DOLARAPI_PARALLEL_URL = 'https://ve.dolarapi.com/v1/dolares/paralelo';
const SOURCE_TIMEOUT_MS = 6000;
const USD_VES_RATE_CACHE_MS = 12 * 60 * 60 * 1000;
const BINANCE_RATE_SOURCE = 'binance_p2p';
const DOLARAPI_RATE_SOURCE = 'dolarapi_paralelo';
const LEGACY_BINANCE_RATE_SOURCE = 'binance_p2p_usdt_ves';

type PricingRow = {
  variant_id: string;
  final_price_usd: number | string | null;
};

type StoredRate = {
  rate: number;
  updatedAt: string | null;
  storageSource: string;
  provider: string;
};

type PersistResult = {
  productPricingUpdated: number;
  exchangeRateUpdated: boolean;
  warnings: string[];
};

type RateProvider = typeof BINANCE_RATE_SOURCE | typeof DOLARAPI_RATE_SOURCE;

type FetchedRate = {
  rate: number;
  source: 'montosve' | 'fallback';
  rateSource: RateProvider;
  tradeType: 'buy' | null;
  sourceUpdatedAt: string | null;
  warning?: string;
};

type RefreshedRate = {
  success: true;
  rate: number;
  bcv_rate: number;
  source: 'montosve' | 'fallback';
  rate_source: string;
  trade_type: 'buy' | null;
  source_updated_at: string | null;
  updatedAt: string | null;
  stale: boolean;
  persisted: boolean;
  cached?: boolean;
  warning?: string;
};

type MontosveRate = {
  rate: number;
  updatedAt: string | null;
};

function originForProvider(provider: string): 'montosve' | 'fallback' {
  return provider === BINANCE_RATE_SOURCE ? 'montosve' : 'fallback';
}

export async function refreshBcvRate(
  options: { forceRefresh?: boolean } = {}
): Promise<RefreshedRate> {
  const sourceErrors: string[] = [];
  let storedRate: StoredRate | null = null;
  let storedRateReadError: unknown = null;

  try {
    storedRate = await getStoredBcvRate();
    if (
      !options.forceRefresh
      && storedRate?.storageSource === 'exchange_rates'
      && (storedRate.provider === BINANCE_RATE_SOURCE || storedRate.provider === DOLARAPI_RATE_SOURCE)
      && isFreshStoredRate(storedRate)
    ) {
      return {
        success: true as const,
        rate: storedRate.rate,
        bcv_rate: storedRate.rate,
        source: originForProvider(storedRate.provider),
        rate_source: storedRate.provider,
        trade_type: storedRate.provider === BINANCE_RATE_SOURCE ? 'buy' as const : null,
        source_updated_at: null,
        updatedAt: storedRate.updatedAt,
        stale: false,
        persisted: true,
        cached: true,
      };
    }
  } catch (error) {
    storedRateReadError = error;
    console.error('[usd-ves][stored-rate] Falló la lectura de la tasa almacenada:', error);
  }

  try {
    const fetchedRate = await fetchUsdVesRate(process.env.MONTOSVE_API_KEY || '');
    const persisted = await persistBcvRate(fetchedRate.rate, fetchedRate.rateSource);
    const warnings = [fetchedRate.warning, ...persisted.warnings].filter(Boolean);
    return {
      success: true as const,
      rate: fetchedRate.rate,
      bcv_rate: fetchedRate.rate,
      source: fetchedRate.source,
      rate_source: fetchedRate.rateSource,
      trade_type: fetchedRate.tradeType,
      source_updated_at: fetchedRate.sourceUpdatedAt,
      updatedAt: new Date().toISOString(),
      stale: false,
      persisted: persisted.exchangeRateUpdated,
      ...(warnings.length > 0
        ? { warning: warnings.join(' ') }
        : {}),
    };
  } catch (error) {
    const message = errorMessage(error);
    sourceErrors.push(message);
    console.error('Error obteniendo la tasa Binance P2P o su respaldo DolarAPI:', error);
  }

  if (!storedRate) {
    try {
      storedRate = await getStoredBcvRate();
    } catch (error) {
      storedRateReadError = error;
      console.error('[usd-ves][stored-rate] Falló la lectura de la tasa de respaldo en Supabase:', error);
    }
  }

  if (storedRate) {
    console.warn(`[usd-ves][fallback:${storedRate.provider}] Se usará la última tasa USD/VES válida guardada.`);
    return {
      success: true as const,
      rate: storedRate.rate,
      bcv_rate: storedRate.rate,
      source: originForProvider(storedRate.provider),
      rate_source: storedRate.provider,
      trade_type: null,
      source_updated_at: null,
      updatedAt: storedRate.updatedAt,
      stale: true,
      persisted: true,
      warning: [
        'Binance P2P y DolarAPI no respondieron; se devuelve la última tasa guardada en Supabase.',
        ...sourceErrors,
      ].join(' '),
    };
  }

  if (storedRateReadError) {
    throw new Error(
      `Fallaron Binance P2P/DolarAPI (${sourceErrors.join('; ')}) y la lectura de Supabase (${errorMessage(storedRateReadError)}).`
    );
  }

  throw new Error(
    `Fallaron Binance P2P/DolarAPI (${sourceErrors.join('; ')}) y no existe una tasa válida guardada en Supabase.`
  );
}

function isFreshStoredRate(storedRate: StoredRate) {
  if (!storedRate.updatedAt) return false;
  const updatedAt = Date.parse(storedRate.updatedAt);
  const age = Date.now() - updatedAt;
  return Number.isFinite(updatedAt) && age >= 0 && age < USD_VES_RATE_CACHE_MS;
}

export async function getStoredBcvRate(): Promise<StoredRate | null> {
  const supabase = getSupabaseServerClient();
  let exchangeRate: { source: string; rate: number | string; updated_at: string } | null = null;
  let exchangeRateLookupError: string | null = null;

  try {
    const { data, error } = await supabase
      .from('exchange_rates')
      .select('source, rate, updated_at')
      .eq('currency', 'USD')
      .in('source', [BINANCE_RATE_SOURCE, DOLARAPI_RATE_SOURCE])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    exchangeRate = data;
  } catch (error) {
    exchangeRateLookupError = errorMessage(error);
    console.warn('[usd-ves][stored-rate:exchange_rates] No se pudo consultar la tasa más reciente:', error);
  }

  if (exchangeRate) {
    const rate = toValidRate(exchangeRate.rate);
    if (rate === null) {
      throw new Error('La tasa USD/VES guardada en exchange_rates no es válida.');
    }
    return {
      rate,
      updatedAt: exchangeRate.updated_at,
      storageSource: 'exchange_rates',
      provider: exchangeRate.source,
    };
  }

  try {
    const { data: binanceRate, error: binanceRateError } = await supabase
      .from('exchange_rates')
      .select('rate, updated_at')
      .eq('source', LEGACY_BINANCE_RATE_SOURCE)
      .maybeSingle();

    if (binanceRateError) throw binanceRateError;
    const legacyRate = toValidRate(binanceRate?.rate);
    if (legacyRate !== null) {
      return {
        rate: legacyRate,
        updatedAt: binanceRate.updated_at,
        storageSource: 'legacy_exchange_rates',
        provider: BINANCE_RATE_SOURCE,
      };
    }
  } catch (error) {
    console.warn('[usd-ves][stored-rate:legacy-binance] No se pudo leer la tasa Binance P2P anterior:', error);
  }

  throw new Error(
    `No existe una tasa Binance P2P en exchange_rates (${exchangeRateLookupError ?? 'sin fila'}) ni en el registro Binance P2P anterior.`
  );
}

export async function fetchMontosveRate(apiKey: string): Promise<MontosveRate> {
  if (!apiKey) {
    throw new Error('Falta configurar MONTOSVE_API_KEY.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);

  try {
    const response = await fetch(MONTOSVE_RATES_URL, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-API-Key': apiKey,
        'Cache-Control': 'no-store',
      },
      signal: controller.signal,
    });
    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(`MontosVE respondió HTTP ${response.status}. Respuesta cruda: ${rawText}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`La respuesta no es JSON válido: ${errorMessage(error)}. Respuesta cruda: ${rawText}`);
    }

    const montosveRate = extractMontosveBinanceRate(payload);
    if (montosveRate === null || montosveRate.rate < 1 || montosveRate.rate > 10000) {
      throw new Error(`La respuesta JSON no contiene una tasa Binance P2P USDT/VES válida para BUY. Respuesta cruda: ${rawText}`);
    }
    return montosveRate;
  } finally {
    clearTimeout(timeout);
  }
}

function extractMontosveBinanceRate(payload: unknown): MontosveRate | null {
  const root = asRecord(payload);
  if (root?.success === false || root?.ok === false) return null;

  const rates = Array.isArray(root?.data) ? root.data : [];
  const binanceP2pRate = rates.find((entry) => {
    const record = asRecord(entry);
    return typeof record?.market === 'string'
      && record.market.toLowerCase() === BINANCE_RATE_SOURCE
      && typeof record.currency_pair === 'string'
      && record.currency_pair.toUpperCase() === 'USDT/VES'
      && typeof record.trade_type === 'string'
      && record.trade_type.toLowerCase() === 'buy';
  });
  const record = asRecord(binanceP2pRate);
  const rawRate = record?.rate;
  const parsedRate = typeof rawRate === 'number'
    ? rawRate
    : typeof rawRate === 'string'
      ? Number(rawRate.trim().replace(',', '.'))
      : NaN;
  if (!Number.isFinite(parsedRate) || parsedRate < 1 || parsedRate > 10000) return null;

  const rawUpdatedAt = record?.updated_at;
  const updatedAt = typeof rawUpdatedAt === 'string' && Number.isFinite(Date.parse(rawUpdatedAt))
    ? rawUpdatedAt
    : null;
  return { rate: parsedRate, updatedAt };
}

async function fetchDolarApiRate(): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);

  try {
    const response = await fetch(DOLARAPI_PARALLEL_URL, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
      signal: controller.signal,
    });
    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(`DolarAPI respondió HTTP ${response.status}. Respuesta cruda: ${rawText}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`La respuesta de DolarAPI no es JSON válido: ${errorMessage(error)}. Respuesta cruda: ${rawText}`);
    }

    const rate = toValidRate(asRecord(payload)?.promedio);
    if (rate === null || rate < 1 || rate > 10000) {
      throw new Error(`La respuesta de DolarAPI no contiene un promedio válido. Respuesta cruda: ${rawText}`);
    }
    return rate;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUsdVesRate(apiKey: string): Promise<FetchedRate> {
  try {
    const montosveRate = await fetchMontosveRate(apiKey);
    return {
      rate: montosveRate.rate,
      source: 'montosve',
      rateSource: BINANCE_RATE_SOURCE,
      tradeType: 'buy',
      sourceUpdatedAt: montosveRate.updatedAt,
    };
  } catch (primaryError) {
    try {
      return {
        rate: await fetchDolarApiRate(),
        source: 'fallback',
        rateSource: DOLARAPI_RATE_SOURCE,
        tradeType: null,
        sourceUpdatedAt: null,
        warning: `MontosVE Binance P2P falló; se usó DolarAPI paralelo. ${errorMessage(primaryError)}`,
      };
    } catch (fallbackError) {
      throw new Error(
        `MontosVE Binance P2P falló (${errorMessage(primaryError)}); DolarAPI también falló (${errorMessage(fallbackError)}).`
      );
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toValidRate(value: unknown) {
  const rate = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim().replace(',', '.'))
      : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

async function persistBcvRate(
  rate: number,
  source: typeof BINANCE_RATE_SOURCE | typeof DOLARAPI_RATE_SOURCE
): Promise<PersistResult> {
  const warnings: string[] = [];
  let productPricingUpdated = 0;
  let exchangeRateUpdated = false;
  const updatedAt = new Date().toISOString();

  let supabase: ReturnType<typeof getSupabaseServerClient>;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    const message = `No se pudo inicializar Supabase: ${errorMessage(error)}`;
    console.error(`[usd-ves][persist] ${message}`);
    return {
      productPricingUpdated,
      exchangeRateUpdated,
      warnings: [message],
    };
  }

  try {
    const { data: pricingRows, error: pricingError } = await supabase
      .from('product_pricing')
      .select('variant_id, final_price_usd');
    if (pricingError) throw pricingError;

    for (const row of (pricingRows ?? []) as PricingRow[]) {
      const finalPriceUsd = row.final_price_usd === null ? null : toValidRate(row.final_price_usd);
      const updates: { bcv_rate: number; final_price_bs?: number; updated_at: string } = {
        bcv_rate: rate,
        updated_at: updatedAt,
      };
      if (finalPriceUsd !== null) {
        updates.final_price_bs = Number((finalPriceUsd * rate).toFixed(2));
      }

      const { error: updateError } = await supabase
        .from('product_pricing')
        .update(updates)
        .eq('variant_id', row.variant_id);
      if (updateError) {
        throw new Error(`${row.variant_id}: ${errorMessage(updateError)}`);
      }
      productPricingUpdated += 1;
    }
  } catch (error) {
    const message = `No se pudo actualizar product_pricing.bcv_rate/precio en Bs.: ${errorMessage(error)}`;
    warnings.push(message);
    console.error(`[usd-ves][persist:product_pricing] ${message}`);
  }

  try {
    const { error } = await supabase
      .from('exchange_rates')
      .upsert(
        { source, currency: 'USD', rate, updated_at: updatedAt },
        { onConflict: 'currency' }
      );
    if (error) throw error;
    exchangeRateUpdated = true;
  } catch (error) {
    const message = `No se pudo actualizar exchange_rates: ${errorMessage(error)}`;
    warnings.push(message);
    console.error(`[usd-ves][persist:exchange_rates] ${message}`);
  }

  return { productPricingUpdated, exchangeRateUpdated, warnings };
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return 'error desconocido';
}
