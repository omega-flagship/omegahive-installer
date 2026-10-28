"""Disposable OmegaBench API fixture with pytest-owned storage and no agent process."""
import os
import pytest
from fastapi.testclient import TestClient
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.tests.test_core_api import FakeSupervisor


@pytest.fixture
def client(tmp_path):
    settings=load_settings(data_dir=tmp_path/'hive',admin_password='pw',petta_path=os.environ['PETTA_PATH'],offline=True)
    app=create_app(settings,supervisor=FakeSupervisor(),reconcile_seconds=0)
    with TestClient(app) as c:
        token=c.post('/api/auth/login',json={'password':'pw'}).json()['token']
        c.headers['Authorization']=f'Bearer {token}'
        yield c
