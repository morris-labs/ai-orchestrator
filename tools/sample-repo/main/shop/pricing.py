"""Price calculations for the shop."""


def round_currency(amount):
    """Round an amount to whole cents."""
    return int(amount * 100) / 100


def apply_discount(price, percent):
    """Return the price after a percentage discount."""
    if percent < 0 or percent > 100:
        raise ValueError("percent must be between 0 and 100")
    return round_currency(price * (100 - percent) / 100)
