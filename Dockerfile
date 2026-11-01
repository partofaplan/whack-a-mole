FROM nginx:alpine
COPY index.html style.css game.js auth.js /usr/share/nginx/html/
EXPOSE 80
