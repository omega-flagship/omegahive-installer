"""Host-owned launcher identity; no person/mind action or tool dispatch."""


def describe():
    return {
        'contract': '0.1',
        'kinds': [{'id': 'launcher', 'label': 'Project test launcher', 'role': 'other'}],
        'relations': [],
        'actions': [],
    }


def view(ctx, focus, stage):
    return {
        'revision': 'launcher-contract-1',
        'title': 'Code project test launcher',
        'items': [],
        'links': [],
    }


def act(ctx, action, items, params):
    return {'status': 'refused', 'message': 'This launcher has no public actions.'}
