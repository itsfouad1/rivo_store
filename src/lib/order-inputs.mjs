export function accountInput(item, product, legacy, fail) {
  const own = Object.hasOwn(item, 'player_id'),
    value = own ? item.player_id : product.player_id_required ? legacy : '';
  if (typeof value !== 'string' || value.length > 150 || /[\x00-\x1f\x7f]/.test(value))
    fail(400, 'معرّف اللاعب / الحساب غير صالح للمنتج: ' + product.name);
  const account = value.trim();
  if (product.player_id_required && !account)
    fail(400, 'معرّف اللاعب / الحساب مطلوب للمنتج: ' + product.name);
  if (!product.player_id_required && account)
    fail(400, 'هذا المنتج لا يطلب معرّف لاعب / حساب: ' + product.name);
  return account;
}
