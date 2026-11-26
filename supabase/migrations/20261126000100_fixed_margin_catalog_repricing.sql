create or replace function public.recalculate_catalog_with_fixed_margin(
  p_bcv_rate numeric,
  p_margin_usd numeric,
  p_updated_at timestamptz
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
    raise exception 'La tasa BCV debe estar entre 1 y 10000.';
  end if;

  if p_margin_usd is null or p_margin_usd <= 0 then
    raise exception 'El margen fijo en USD debe ser mayor que cero.';
  end if;

  insert into public.exchange_rates (currency, rate, updated_at)
  values ('USD', p_bcv_rate, v_updated_at)
  on conflict (currency) do update
  set rate = excluded.rate,
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
    'updated_at', v_updated_at,
    'products_updated', v_products_updated,
    'products', v_products,
    'skipped_products', v_skipped_products
  );
end;
$$;

revoke all on function public.recalculate_catalog_with_fixed_margin(numeric, numeric, timestamptz)
  from public, anon, authenticated;
grant execute on function public.recalculate_catalog_with_fixed_margin(numeric, numeric, timestamptz)
  to service_role;
