drop policy if exists "Checkout can create pending sales" on public.sales;
drop policy if exists "Checkout can read public order identifiers" on public.sales;
drop policy if exists "Checkout can upload payment proofs" on storage.objects;

revoke all on public.sales from anon;
revoke insert, update, delete on public.sales from authenticated;
revoke insert (order_id, variant_id, total, payment_method, payment_reference, customer_info, status)
  on public.sales from anon, authenticated;
revoke select (id, order_id)
  on public.sales from anon;
