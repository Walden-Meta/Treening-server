from .api import api_bp
from .setup import setup_bp
from .views import views_bp

blueprints = [views_bp, api_bp, setup_bp]

