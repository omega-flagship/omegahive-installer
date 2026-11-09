"""Host-owned runner identity; no person/mind action or tool dispatch."""


def describe():
    return {
        'contract': '0.1',
        'kinds': [{'id': 'runner', 'label': 'Acceptance check runner', 'role': 'other'}],
        'relations': [],
        'actions': [],
    }


def view(ctx, focus, stage):
    return {'revision': 'runner-contract-1', 'title': 'Create acceptance check runner', 'items': [], 'links': []}


def act(ctx, action, items, params):
    return {'status': 'refused', 'message': 'This runner has no public actions.'}
