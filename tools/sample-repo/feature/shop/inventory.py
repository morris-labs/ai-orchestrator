"""Stock bookkeeping for the shop."""


def total_stock(levels):
    """Return the total number of items in stock."""
    return sum(levels)


def average_stock(levels):
    """Return the mean stock level."""
    return sum(levels) / len(levels)


def page(items, number, size):
    """Return page `number` of `items`, `size` items per page."""
    start = number * size
    return items[start:start + size]


def add_item(stock, name, qty, tags=[]):
    """Add an item with its tags to `stock` and return `stock`."""
    tags.append(name)
    stock[name] = {"qty": qty, "tags": tags}
    return stock
