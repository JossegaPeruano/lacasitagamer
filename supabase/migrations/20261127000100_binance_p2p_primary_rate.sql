alter table public.exchange_rates
  alter column source set default 'binance_p2p';

delete from public.exchange_rates
where source = 'bcv_official_ves';

delete from public.exchange_rates
where currency = 'USD'
  and source not in ('binance_p2p', 'dolarapi_paralelo');

update public.exchange_rates
set currency = null
where source = 'dolarapi_paralelo';

update public.exchange_rates
set currency = 'USD',
    updated_at = least(updated_at, now() - interval '13 hours')
where source = 'binance_p2p';

delete from public.exchange_rates as fallback_rate
where fallback_rate.source = 'dolarapi_paralelo'
  and exists (
    select 1
    from public.exchange_rates as primary_rate
    where primary_rate.source = 'binance_p2p'
  );

update public.exchange_rates
set currency = 'USD',
    updated_at = least(updated_at, now() - interval '13 hours')
where source = 'dolarapi_paralelo'
  and not exists (
    select 1
    from public.exchange_rates as primary_rate
    where primary_rate.source = 'binance_p2p'
  );

create or replace function public.recalculate_catalog_with_fixed_margin(
  p_bcv_rate numeric,
  p_margin_usd numeric,
  p_updated_at timestamptz,
  p_rate_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated_at timestamptz := coalesce(p_updated_at, now());
  v_products_updated integer;
  v_products jsonb;
  v_skipped_products jsonb;
begin
  if p_bcv_rate is null or p_bcv_rate < 1 or p_bcv_rate > 10000 then
    raise exception 'La tasa USD/VES debe estar entre 1 y 10000.';
  end if;

  if p_margin_usd is null or p_margin_usd <= 0 then
    raise exception 'El margen fijo en USD debe ser mayor que cero.';
  end if;

  if p_rate_source is null or p_rate_source not in ('binance_p2p', 'dolarapi_paralelo') then
    raise exception 'El origen de la tasa USD/VES no está permitido.';
  end if;

  insert into public.exchange_rates (source, currency, rate, updated_at)
  values (p_rate_source, 'USD', p_bcv_rate, v_updated_at)
  on conflict (currency) do update
  set source = excluded.source,
      rate = excluded.rate,
      updated_at = excluded.updated_at;

  with repriced_products as (
    update public.product_pricing as pricing
    set final_price_usd = round(coalesce(pricing.current_cost_usd, pricing.fallback_cost_usd) + p_margin_usd, 2),
        final_price_bs = round(
          round(coalesce(pricing.current_cost_usd, pricing.fallback_cost_usd) + p_margin_usd, 2) * p_bcv_rate,
          2
        ),
        bcv_rate = p_bcv_rate,
        price_checked_at = v_updated_at,
        updated_at = v_updated_at
    where coalesce(pricing.current_cost_usd, pricing.fallback_cost_usd) > 0
    returning
      pricing.variant_id,
      pricing.product_id,
      coalesce(pricing.current_cost_usd, pricing.fallback_cost_usd) as base_price_usd,
      pricing.final_price_usd,
      pricing.final_price_bs
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'variant_id', variant_id,
           'product_id', product_id,
           'base_price_usd', base_price_usd,
           'final_price_usd', final_price_usd,
           'final_price_bs', final_price_bs
         ) order by variant_id), '[]'::jsonb)
    into v_products_updated, v_products
    from repriced_products;

  select coalesce(jsonb_agg(jsonb_build_object(
           'variant_id', pricing.variant_id,
           'product_id', pricing.product_id
         ) order by pricing.variant_id), '[]'::jsonb)
    into v_skipped_products
    from public.product_pricing as pricing
   where coalesce(pricing.current_cost_usd, pricing.fallback_cost_usd) is null
      or coalesce(pricing.current_cost_usd, pricing.fallback_cost_usd) <= 0;

  return jsonb_build_object(
    'success', true,
    'bcv_rate', p_bcv_rate,
    'rate_source', p_rate_source,
    'updated_at', v_updated_at,
    'products_updated', v_products_updated,
    'products', v_products,
    'skipped_products', v_skipped_products
  );
end;
$$;

revoke all on function public.recalculate_catalog_with_fixed_margin(numeric, numeric, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.recalculate_catalog_with_fixed_margin(numeric, numeric, timestamptz, text)
  to service_role;

create or replace function public.sync_exchange_rate_and_recalculate_catalog(
  p_bcv_rate numeric,
  p_updated_at timestamptz,
  p_rate_source text,
  p_supplier_prices jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if p_rate_source is null or p_rate_source not in ('binance_p2p', 'dolarapi_paralelo') then
    raise exception 'El origen de la tasa USD/VES no está permitido.';
  end if;

  v_result := public.sync_exchange_rate_and_recalculate_catalog(
    p_bcv_rate,
    p_updated_at,
    p_supplier_prices
  );

  update public.exchange_rates
  set source = p_rate_source
  where currency = 'USD';

  return v_result || jsonb_build_object('rate_source', p_rate_source);
end;
$$;

revoke all on function public.sync_exchange_rate_and_recalculate_catalog(numeric, timestamptz, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_exchange_rate_and_recalculate_catalog(numeric, timestamptz, text, jsonb)
  to service_role;
