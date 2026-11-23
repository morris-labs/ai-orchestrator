"""Sales tax."""


def add_tax(price, rate):
    """Returns the price plus tax at the rate, rounded to cents."""
    return round(price * (1 + rate), 2)
