"""Suppress configuration values before a logging handler can format them.

Upstream currently interpolates values into its log messages. Filtering the
record (rather than relying on a level) also protects DEBUG deployments and
handlers attached directly to the config logger.
"""
import logging


class ConfigPrivacyFilter(logging.Filter):
    def filter(self, record):
        record.msg = "Omega configuration event (values suppressed)"
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True


def protect_config_logger():
    logger = logging.getLogger('config')
    if not any(isinstance(f, ConfigPrivacyFilter) for f in logger.filters):
        logger.addFilter(ConfigPrivacyFilter())
