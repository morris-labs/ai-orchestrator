"""Price calculations for the shop."""


def round_currency(amount):
    """Round an amount to whole cents."""
    return int(amount * 100) / 100


def apply_discount(price, percent):
    """Return the price after a percentage discount."""
    if percent < 0 or percent > 100:
        raise ValueError("percent must be between 0 and 100")
    return round_currency(price * (100 - percent) / 100)


def bulk_discount(quantity):
    """Return the discount percent for an order of `quantity` items.

    Orders of 100 items or more get 10 percent; 50 or more get 5 percent.
    """
    if quantity > 100:
        return 10
    if quantity >= 50:
        return 5
    return 0


def average_price(prices):
    """Return the mean of a list of prices, rounded to cents."""
    return round_currency(sum(prices) / len(prices))
