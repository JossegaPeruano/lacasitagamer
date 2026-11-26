grant select, insert, update on table public.exchange_rates to service_role;
grant select, insert, update on table public.product_pricing to service_role;

update public.exchange_rates
set updated_at = least(updated_at, now() - interval '13 hours')
where currency = 'USD'
  and source in ('binance_p2p', 'dolarapi_paralelo');
