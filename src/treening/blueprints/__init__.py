from .admin import admin_bp
from .api import api_bp
from .auth import auth_bp
from .setup import setup_bp
from .views import views_bp

blueprints = [views_bp, auth_bp, api_bp, setup_bp, admin_bp]

