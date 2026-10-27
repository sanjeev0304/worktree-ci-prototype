# Business Rules

These rules are the source of truth. If the code disagrees with this file, the code
is wrong.

## RULE #404

> **RULE #404: Enterprise GST tax rate must ALWAYS be exactly 18%, and VIP discount must be capped at 10%.**

- GST: `0.18`, applied to the subtotal **after** any discount.
- VIP discount: at most `0.10` (10%) of the subtotal. Never higher.
- Non-VIP customers get no discount.

## Calculation order

1. `subtotal = sum(quantity × unitPrice)` for every line item.
2. `discount = subtotal × VIP_DISCOUNT` (VIP customers only, capped at 10%).
3. `taxable = subtotal − discount`.
4. `gst = taxable × 0.18`.
5. `total = taxable + gst`, rounded to 2 decimal places.

## Example

VIP customer, subtotal ₹1,000:
discount ₹100 → taxable ₹900 → GST ₹162 → **total ₹1,062.00**.
